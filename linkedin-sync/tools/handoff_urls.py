#!/usr/bin/env python3
"""Hand LinkedIn article URLs to the droplet via git.

Validates and normalises URLs, appends the new ones to
linkedin-sync/article-urls.txt, commits, pushes to origin/main, then runs the
droplet sync over SSH. Status messages go to stderr; stdout is only JSON.

Exit codes: 0 ok, 2 bad input, 3 git guard failed, 4 commit/push failed,
5 SSH sync step failed or not configured.

Environment (kept outside the repo):
  MOTETHANSEN_DROPLET_SSH  SSH config host alias for the droplet
  MOTETHANSEN_SYNC_CMD     remote command that runs sync-from-git.sh
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
from urllib.parse import urlsplit

URLS_RELPATH = os.path.join("linkedin-sync", "article-urls.txt")
SSH_ENV = "MOTETHANSEN_DROPLET_SSH"
SYNC_ENV = "MOTETHANSEN_SYNC_CMD"
SSH_TIMEOUT = 300
_HOST = "www.linkedin.com"


class HandoffError(Exception):
    def __init__(self, code, message, committed=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.committed = committed


def log(message):
    print(message, file=sys.stderr)


def normalise_url(url):
    """Drop query, fragment and trailing slash. Raises ValueError if unparsable."""
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    return "%s://%s%s" % (parts.scheme, parts.netloc, path)


def validate(url):
    """Return the normalised URL, or raise ValueError saying what is wrong."""
    try:
        parts = urlsplit(url.strip())
        parts.port  # raises ValueError on a malformed port
    except ValueError:
        raise ValueError("not a valid URL: %r" % url)
    if parts.scheme != "https":
        raise ValueError("scheme must be https: %r" % url)
    if parts.netloc != _HOST:
        raise ValueError("host must be exactly %s: %r" % (_HOST, url))
    path = parts.path.rstrip("/")
    prefix = "/pulse/"
    if not path.startswith(prefix):
        raise ValueError("path must start with /pulse/: %r" % url)
    slug = path[len(prefix):]
    if not slug or "/" in slug:
        raise ValueError("path must be /pulse/<slug>: %r" % url)
    return normalise_url(url)


def _content_lines(path):
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if line and not line.startswith("#"):
                yield line


def load_existing(path):
    """Normalised set of URLs already listed (comments and blanks ignored)."""
    existing = set()
    for line in _content_lines(path):
        try:
            existing.add(normalise_url(line))
        except ValueError:
            existing.add(line)
    return existing


def load_owner_list(path):
    owned = set()
    for line in _content_lines(path):
        try:
            owned.add(normalise_url(line))
        except ValueError:
            continue
    return owned


def git(repo, *args):
    return subprocess.run(
        ["git"] + list(args), cwd=repo,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def guard(repo):
    """Raise HandoffError(3) unless the clone is clean and not behind origin/main."""
    status = git(repo, "status", "--porcelain")
    if status.returncode != 0:
        raise HandoffError(3, "git status failed: %s" % status.stderr.strip())
    if status.stdout.strip():
        raise HandoffError(3, "working tree is not clean; commit or stash first. Nothing was written.")
    fetch = git(repo, "fetch", "origin")
    if fetch.returncode != 0:
        raise HandoffError(3, "git fetch origin failed: %s" % fetch.stderr.strip())
    behind = git(repo, "rev-list", "--count", "HEAD..origin/main")
    if behind.returncode != 0:
        raise HandoffError(3, "could not compare with origin/main: %s" % behind.stderr.strip())
    if int(behind.stdout.strip() or "0") > 0:
        raise HandoffError(3, "local branch is behind origin/main; update it first. Nothing was written.")


def append_urls(path, urls):
    """Append urls, adding a missing trailing newline first. Never rewrites old lines."""
    with open(path, "rb") as fh:
        data = fh.read()
    prefix = "" if (not data or data.endswith(b"\n")) else "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(prefix + "".join(u + "\n" for u in urls))


def commit_and_push(repo, urls_relpath, count):
    """Commit the URL file and push. Returns True on success; raises HandoffError(4)."""
    add = git(repo, "add", "--", urls_relpath)
    if add.returncode != 0:
        raise HandoffError(4, "git add failed: %s" % add.stderr.strip())
    message = "linkedin-sync: add %d article URL(s)" % count
    commit = git(repo, "commit", "-m", message, "--", urls_relpath)
    if commit.returncode != 0:
        raise HandoffError(4, "git commit failed: %s" % (commit.stderr.strip() or commit.stdout.strip()))
    push = git(repo, "push", "origin", "HEAD:main")
    if push.returncode == 0:
        return True
    log("push failed: %s" % push.stderr.strip())
    pull = git(repo, "pull", "--rebase", "origin", "main")
    if pull.returncode != 0:
        git(repo, "rebase", "--abort")
        raise HandoffError(
            4,
            "push step failed, and git pull --rebase hit a conflict; ran git rebase --abort. "
            "The commit remains locally; it was not pushed.",
            committed=True,
        )
    raise HandoffError(
        4,
        "push step failed; ran git pull --rebase once and stopped (no second push). "
        "The commit remains locally; push it manually after checking the result.",
        committed=True,
    )


def trigger_sync(env=None):
    """Run the droplet sync over SSH. Raises HandoffError(5) on any problem."""
    env = os.environ if env is None else env
    alias = env.get(SSH_ENV)
    remote_cmd = env.get(SYNC_ENV)
    for name, value in ((SSH_ENV, alias), (SYNC_ENV, remote_cmd)):
        if not value:
            raise HandoffError(
                5, "environment variable %s is not set; the URL is already pushed to origin "
                   "but the droplet was not synced." % name, committed=True)
    argv = ["ssh", "-o", "BatchMode=yes", alias] + shlex.split(remote_cmd)
    try:
        result = subprocess.run(argv, timeout=SSH_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HandoffError(5, "SSH sync step failed: timed out after %ds. The URL is already pushed." % SSH_TIMEOUT, committed=True)
    except OSError as exc:
        raise HandoffError(5, "SSH sync step failed: %s. The URL is already pushed." % exc, committed=True)
    if result.returncode != 0:
        raise HandoffError(
            5, "SSH sync step failed (exit %d). The URL is already pushed." % result.returncode,
            committed=True)


def _default_repo():
    here = os.path.dirname(os.path.abspath(__file__))
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], cwd=here,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if out.returncode != 0:
        raise HandoffError(2, "could not find the git toplevel; pass --repo.")
    return out.stdout.strip()


def _emit(added, committed, synced):
    print(json.dumps({"added": added, "committed": committed, "synced": synced}))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Add LinkedIn article URLs and sync the droplet.")
    parser.add_argument("urls", nargs="+", metavar="URL")
    parser.add_argument("--owner-check", metavar="PATH")
    parser.add_argument("--repo", metavar="PATH")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2

    added = []
    try:
        # 1. validate everything before touching git
        normalised = []
        problems = []
        for url in args.urls:
            try:
                normalised.append(validate(url))
            except ValueError as exc:
                problems.append(str(exc))
        if args.owner_check and not problems:
            try:
                owned = load_owner_list(args.owner_check)
            except OSError as exc:
                raise HandoffError(2, "cannot read --owner-check file: %s" % exc)
            for url in normalised:
                if url not in owned:
                    problems.append("not in owner-check list: %s" % url)
        if problems:
            raise HandoffError(2, "rejected, no changes made:\n  " + "\n  ".join(problems))

        repo = os.path.abspath(args.repo) if args.repo else _default_repo()
        urls_path = os.path.join(repo, URLS_RELPATH)

        # 2. guard
        guard(repo)
        if not os.path.isfile(urls_path):
            raise HandoffError(3, "%s not found in the repo." % URLS_RELPATH)

        # 3. dedupe
        existing = load_existing(urls_path)
        for url in normalised:
            if url not in existing and url not in added:
                added.append(url)
        if not added:
            log("no new URLs to add")
            _emit([], False, False)
            return 0

        # 4-5. append, commit, push
        append_urls(urls_path, added)
        log("appending %d URL(s)" % len(added))
        commit_and_push(repo, URLS_RELPATH, len(added))

        # 6. droplet sync
        trigger_sync()
    except HandoffError as exc:
        log("error: %s" % exc.message)
        if exc.code in (4, 5):
            _emit(added, exc.committed, False)
        return exc.code

    _emit(added, True, True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
