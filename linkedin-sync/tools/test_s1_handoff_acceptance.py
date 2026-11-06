"""S-1 acceptance tests for handoff_urls.py, written from the public CLI contract.

Uses a temp bare origin + clone and a fake `ssh` on PATH; nothing live is touched.
"""
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "handoff_urls.py")
A = "https://www.linkedin.com/pulse/article-one-someone"
B = "https://www.linkedin.com/pulse/article-two-someone"


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def env(tmp_path):
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(origin)], check=True,
                   capture_output=True)
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", str(origin), str(clone)], check=True,
                   capture_output=True)
    for k, v in (("user.email", "t@example.com"), ("user.name", "T")):
        git(clone, "config", k, v)
    git(clone, "checkout", "-B", "main")
    d = clone / "linkedin-sync"
    d.mkdir()
    (d / "article-urls.txt").write_text("https://www.linkedin.com/pulse/existing-one\n")
    git(clone, "add", "-A")
    git(clone, "commit", "-m", "init")
    git(clone, "push", "-u", "origin", "main")

    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "ssh.log"
    ssh = bindir / "ssh"
    ssh.write_text('#!/bin/sh\necho "$@" >> "%s"\nexit ${FAKE_SSH_RC:-0}\n' % log)
    ssh.chmod(0o755)
    e = dict(os.environ)
    e.update(PATH=str(bindir) + os.pathsep + e["PATH"],
             MOTETHANSEN_DROPLET_SSH="fake-alias",
             MOTETHANSEN_SYNC_CMD="bash /x/sync-from-git.sh")
    return {"clone": clone, "origin": origin, "env": e, "log": log, "tmp": tmp_path}


def run(env, *urls, extra=(), envover=None):
    e = dict(env["env"])
    e.update(envover or {})
    return subprocess.run([sys.executable, SCRIPT, "--repo", str(env["clone"]), *extra, *urls],
                          capture_output=True, text=True, env=e)


def listed(env):
    return (env["clone"] / "linkedin-sync" / "article-urls.txt").read_text().split()


def head(path):
    return git(path, "rev-parse", "HEAD")


def last_json(out):
    return json.loads(out.strip().splitlines()[-1])


def test_adds_commits_pushes_and_syncs(env):
    r = run(env, A + "/")
    assert r.returncode == 0, r.stderr
    assert last_json(r.stdout)["added"] == [A]
    assert A in listed(env)
    assert git(env["clone"], "log", "-1", "--format=%s") == "linkedin-sync: add 1 article URL(s)"
    assert git(env["origin"], "rev-parse", "main") == head(env["clone"])
    assert "fake-alias" in env["log"].read_text()
    assert "sync-from-git.sh" in env["log"].read_text()


def test_normalises_query_and_trailing_slash(env):
    r = run(env, A + "/?trk=public&utm=1")
    assert r.returncode == 0, r.stderr
    assert last_json(r.stdout)["added"] == [A]
    assert A in listed(env) and not any("?" in u for u in listed(env))


def test_multiple_urls_count_in_message(env):
    r = run(env, A, B)
    assert r.returncode == 0, r.stderr
    assert git(env["clone"], "log", "-1", "--format=%s") == "linkedin-sync: add 2 article URL(s)"


def test_dedupes_within_args_and_against_file(env):
    r = run(env, A, A + "/", "https://www.linkedin.com/pulse/existing-one/")
    assert r.returncode == 0, r.stderr
    assert last_json(r.stdout)["added"] == [A]
    assert listed(env).count(A) == 1
    assert listed(env).count("https://www.linkedin.com/pulse/existing-one") == 1


def test_idempotent_second_run(env):
    assert run(env, A).returncode == 0
    h = head(env["clone"])
    r = run(env, A)
    assert r.returncode == 0, r.stderr
    assert last_json(r.stdout)["added"] == []
    assert head(env["clone"]) == h


@pytest.mark.parametrize("bad", [
    "https://www.linkedin.com/in/someone",
    "https://www.linkedin.com/feed/update/123",
    "https://example.com/pulse/foo",
    "http://www.linkedin.com/pulse/foo",
    "https://evil.com/https://www.linkedin.com/pulse/foo",
    "not a url",
])
def test_rejects_non_pulse_urls(env, bad):
    h = head(env["clone"])
    r = run(env, bad)
    assert r.returncode == 2
    assert head(env["clone"]) == h
    assert bad not in listed(env)


def test_one_bad_url_rejects_all(env):
    h = head(env["clone"])
    r = run(env, A, "https://www.linkedin.com/in/x")
    assert r.returncode == 2
    assert head(env["clone"]) == h and A not in listed(env)


def test_owner_check_accepts_listed_rejects_unlisted(env):
    cand = env["tmp"] / "cands.txt"
    cand.write_text("# mine\n%s\n" % A)
    ok = run(env, A, extra=["--owner-check", str(cand)])
    assert ok.returncode == 0, ok.stderr
    h = head(env["clone"])
    bad = run(env, B, extra=["--owner-check", str(cand)])
    assert bad.returncode == 2
    assert head(env["clone"]) == h and B not in listed(env)


def test_refuses_dirty_clone(env):
    (env["clone"] / "stray.txt").write_text("x")
    h = head(env["clone"])
    r = run(env, A)
    assert r.returncode == 3
    assert r.stderr.strip()
    assert head(env["clone"]) == h and A not in listed(env)


def test_refuses_modified_tracked_file(env):
    p = env["clone"] / "linkedin-sync" / "article-urls.txt"
    p.write_text(p.read_text() + "\n# local edit\n")
    assert run(env, A).returncode == 3


def test_refuses_when_behind_origin(env):
    other = env["tmp"] / "other"
    subprocess.run(["git", "clone", str(env["origin"]), str(other)], check=True,
                   capture_output=True)
    git(other, "config", "user.email", "o@example.com")
    git(other, "config", "user.name", "O")
    (other / "new.txt").write_text("n")
    git(other, "add", "-A")
    git(other, "commit", "-m", "upstream")
    git(other, "push", "origin", "main")
    h = head(env["clone"])
    r = run(env, A)
    assert r.returncode == 3
    assert head(env["clone"]) == h and A not in listed(env)


def test_push_failure_keeps_local_commit_and_exits_nonzero(env):
    git(env["clone"], "remote", "set-url", "--push", "origin", str(env["tmp"] / "nope.git"))
    r = run(env, A)
    assert r.returncode not in (0, 2, 3)
    assert "push" in r.stderr.lower()
    assert A in listed(env)
    assert git(env["clone"], "log", "-1", "--format=%s").startswith("linkedin-sync: add")
    assert not env["log"].exists()  # ssh not attempted after failed push


def test_ssh_failure_keeps_commit_pushed_no_retry(env):
    r = run(env, A, envover={"FAKE_SSH_RC": "255"})
    assert r.returncode not in (0, 2, 3)
    assert "ssh" in r.stderr.lower() or "sync" in r.stderr.lower()
    assert git(env["origin"], "rev-parse", "main") == head(env["clone"])
    assert len(env["log"].read_text().strip().splitlines()) == 1
