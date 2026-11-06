"""Tests for handoff_urls.py using a temporary bare origin and a working clone.

The SSH step is always mocked; the env vars hold dummy placeholders only.
"""
import importlib.util
import json
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
URLS_REL = os.path.join("linkedin-sync", "article-urls.txt")
BASE = "https://www.linkedin.com/pulse/"
URL_A = BASE + "first-article"
URL_B = BASE + "second-article"


def _load():
    spec = importlib.util.spec_from_file_location(
        "handoff_urls_under_test", os.path.join(HERE, "handoff_urls.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


handoff = _load()


def git(cwd, *args, check=True):
    res = subprocess.run(
        ["git"] + list(args), cwd=str(cwd), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, universal_newlines=True)
    if check and res.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), res.stderr))
    return res.stdout.strip()


def configure(clone):
    git(clone, "config", "user.name", "Test User")
    git(clone, "config", "user.email", "test@example.invalid")


class Env:
    def __init__(self, root):
        self.root = root
        self.origin = root / "origin.git"
        self.clone = root / "clone"
        self.urls = self.clone / URLS_REL
        self.ssh_calls = []

    def origin_log(self):
        return git(self.origin, "log", "--format=%s", "main").splitlines()

    def origin_head(self):
        return git(self.origin, "rev-parse", "main")

    def local_head(self):
        return git(self.clone, "rev-parse", "HEAD")


@pytest.fixture
def env(tmp_path, monkeypatch):
    e = Env(tmp_path)
    git(tmp_path, "init", "--bare", str(e.origin))
    git(e.origin, "symbolic-ref", "HEAD", "refs/heads/main")
    git(tmp_path, "init", str(e.clone))
    git(e.clone, "symbolic-ref", "HEAD", "refs/heads/main")
    configure(e.clone)
    git(e.clone, "remote", "add", "origin", str(e.origin))
    os.makedirs(os.path.dirname(str(e.urls)))
    e.urls.write_text("# comment\n" + BASE + "existing-one\n")
    git(e.clone, "add", ".")
    git(e.clone, "commit", "-m", "initial")
    git(e.clone, "push", "-u", "origin", "main")

    monkeypatch.setenv("MOTETHANSEN_DROPLET_SSH", "dummy-alias")
    monkeypatch.setenv("MOTETHANSEN_SYNC_CMD", "dummy-sync-command")
    monkeypatch.setattr(
        handoff, "trigger_sync", lambda *a, **k: e.ssh_calls.append(1))
    return e


def run(env, capsys, *urls, owner=None):
    argv = list(urls) + ["--repo", str(env.clone)]
    if owner is not None:
        argv += ["--owner-check", str(owner)]
    capsys.readouterr()
    code = handoff.main(argv)
    out = capsys.readouterr().out.strip()
    return code, (json.loads(out) if out else None)


def test_normalisation_strips_query_fragment_trailing_slash(env, capsys):
    code, out = run(env, capsys, URL_A + "/?trackingId=abc#section")
    assert code == 0
    assert out["added"] == [URL_A]
    assert URL_A + "\n" in env.urls.read_text()
    assert "?" not in env.urls.read_text() and "#section" not in env.urls.read_text()


@pytest.mark.parametrize("bad", [
    "https://www.linkedin.com/in/someone",
    "http://www.linkedin.com/pulse/some-article",
    "https://evil.example.com/pulse/some-article",
    "https://www.linkedin.com.evil.example.com/pulse/some-article",
])
def test_invalid_urls_rejected(env, capsys, bad):
    before = env.local_head()
    code, _ = run(env, capsys, bad)
    assert code == 2
    assert env.local_head() == before
    assert env.ssh_calls == []
    assert git(env.clone, "status", "--porcelain") == ""


def test_owner_check_rejects_unlisted_url(env, capsys, tmp_path):
    owner = tmp_path / "owner.txt"
    owner.write_text(URL_B + "\n")
    before = env.local_head()
    code, _ = run(env, capsys, URL_A, owner=owner)
    assert code == 2
    assert env.local_head() == before
    assert env.origin_head() == before
    assert env.ssh_calls == []


def test_owner_check_accepts_listed_url(env, capsys, tmp_path):
    owner = tmp_path / "owner.txt"
    owner.write_text("# candidates\n" + URL_A + "/\n")
    code, out = run(env, capsys, URL_A + "?x=1", owner=owner)
    assert code == 0
    assert out["added"] == [URL_A]
    assert env.origin_log()[0] == "linkedin-sync: add 1 article URL(s)"


def test_add_commits_pushes_and_reports_json(env, capsys):
    before = len(env.origin_log())
    code, out = run(env, capsys, URL_A)
    assert code == 0
    assert out["added"] == [URL_A]
    assert out["committed"] is True and out["synced"] is True
    log = env.origin_log()
    assert len(log) == before + 1
    assert log[0] == "linkedin-sync: add 1 article URL(s)"
    assert env.origin_head() == env.local_head()
    assert env.ssh_calls == [1]


def test_rerun_same_url_makes_no_commit(env, capsys):
    run(env, capsys, URL_A)
    head = env.origin_head()
    calls = len(env.ssh_calls)
    for variant in (URL_A, URL_A + "/", URL_A + "?utm=1", URL_A + "/?a=b#frag"):
        code, out = run(env, capsys, variant)
        assert code == 0
        assert out["added"] == []
        assert env.origin_head() == head
        assert env.local_head() == head
    assert len(env.ssh_calls) == calls


def test_existing_url_is_not_duplicated(env, capsys):
    head = env.local_head()
    code, out = run(env, capsys, BASE + "existing-one/")
    assert code == 0 and out["added"] == []
    assert env.local_head() == head


def test_file_without_trailing_newline(env, capsys):
    env.urls.write_text(BASE + "existing-one")
    git(env.clone, "commit", "-am", "strip newline")
    git(env.clone, "push", "origin", "main")
    code, out = run(env, capsys, URL_A)
    assert code == 0
    lines = env.urls.read_text().splitlines()
    assert lines == [BASE + "existing-one", URL_A]
    assert env.urls.read_text().endswith("\n")


def test_dirty_clone_exits_3_without_writing(env, capsys):
    (env.clone / "stray.txt").write_text("dirty\n")
    before = env.urls.read_text()
    head = env.local_head()
    code, _ = run(env, capsys, URL_A)
    assert code == 3
    assert env.urls.read_text() == before
    assert env.local_head() == head
    assert env.ssh_calls == []


def test_clone_behind_origin_exits_3(env, capsys, tmp_path):
    other = tmp_path / "other"
    git(tmp_path, "clone", str(env.origin), str(other))
    configure(other)
    (other / "extra.txt").write_text("x\n")
    git(other, "add", ".")
    git(other, "commit", "-m", "remote change")
    git(other, "push", "origin", "main")
    before = env.urls.read_text()
    head = env.local_head()
    code, _ = run(env, capsys, URL_A)
    assert code == 3
    assert env.urls.read_text() == before
    assert env.local_head() == head
    assert env.ssh_calls == []


def test_push_failure_exits_4_commit_stays_local(env, capsys):
    hook = env.origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho rejected >&2\nexit 1\n")
    hook.chmod(0o755)
    origin_before = env.origin_head()
    code, out = run(env, capsys, URL_A)
    assert code == 4
    assert out["committed"] is True and out["synced"] is False
    assert env.origin_head() == origin_before
    assert git(env.clone, "log", "-1", "--format=%s") == "linkedin-sync: add 1 article URL(s)"
    assert env.local_head() != origin_before
    assert env.ssh_calls == []


def test_ssh_failure_exits_5_commit_already_on_origin(env, capsys, monkeypatch):
    def boom(*a, **k):
        raise handoff.HandoffError(5, "ssh failed", committed=True)
    monkeypatch.setattr(handoff, "trigger_sync", boom)
    code, out = run(env, capsys, URL_A)
    assert code == 5
    assert out["added"] == [URL_A]
    assert out["committed"] is True and out["synced"] is False
    assert env.origin_log()[0] == "linkedin-sync: add 1 article URL(s)"
    assert env.origin_head() == env.local_head()


def test_multiple_urls_single_commit(env, capsys):
    code, out = run(env, capsys, URL_A, URL_B, URL_A + "/")
    assert code == 0
    assert out["added"] == [URL_A, URL_B]
    assert env.origin_log()[0] == "linkedin-sync: add 2 article URL(s)"


def test_feature_branch_ahead_of_origin_refuses_and_pushes_nothing(env, capsys):
    git(env.clone, "checkout", "-b", "feature")
    (env.clone / "unreviewed.txt").write_text("not for production\n")
    git(env.clone, "add", ".")
    git(env.clone, "commit", "-m", "unreviewed work")
    origin_before = env.origin_head()
    head = env.local_head()
    before = env.urls.read_text()
    code, _ = run(env, capsys, URL_A)
    assert code == 3
    assert env.origin_head() == origin_before
    assert env.local_head() == head
    assert env.urls.read_text() == before
    assert env.ssh_calls == []


def test_main_ahead_of_origin_refuses(env, capsys):
    (env.clone / "unpushed.txt").write_text("x\n")
    git(env.clone, "add", ".")
    git(env.clone, "commit", "-m", "unpushed")
    origin_before = env.origin_head()
    code, _ = run(env, capsys, URL_A)
    assert code == 3
    assert env.origin_head() == origin_before


def test_main_equal_to_origin_pushes_exactly_one_commit(env, capsys):
    origin_before = env.origin_head()
    code, out = run(env, capsys, URL_A)
    assert code == 0
    new = git(env.origin, "rev-list", "%s..main" % origin_before).splitlines()
    assert len(new) == 1
    assert env.origin_head() == env.local_head()


def test_push_failure_does_not_rewrite_history(env, capsys, monkeypatch):
    calls = []
    real_git = handoff.git
    monkeypatch.setattr(
        handoff, "git", lambda repo, *a: (calls.append(a), real_git(repo, *a))[1])
    hook = env.origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho rejected >&2\nexit 1\n")
    hook.chmod(0o755)
    code, out = run(env, capsys, URL_A)
    assert code == 4
    assert git(env.clone, "rev-list", "--count", "origin/main..HEAD") == "1"
    assert not (env.clone / ".git" / "rebase-merge").exists()
    assert not (env.clone / ".git" / "rebase-apply").exists()
    assert ("push", "origin", "main") in calls
    assert not [c for c in calls if c[0] in ("pull", "rebase", "reset", "merge", "push")
                and c != ("push", "origin", "main")]


@pytest.mark.parametrize("bad", ["bash '", 'bash "unterminated', "echo 'a"])
def test_malformed_sync_command_is_exit_5_not_a_traceback(bad):
    """An unbalanced quote in the sync command used to raise ValueError after the push; it must be a normal HandoffError(5)."""
    env = {handoff.SSH_ENV: "droplet-alias", handoff.SYNC_ENV: bad}
    with pytest.raises(handoff.HandoffError) as ei:
        handoff.trigger_sync(env)
    assert ei.value.code == 5 and ei.value.committed is True
