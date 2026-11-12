#!/usr/bin/env python3
"""Paste a LinkedIn article address; it is on motethansen.com a minute later.

    li-add https://www.linkedin.com/pulse/my-new-article-michael-hansen-abc12/

Why this exists: LinkedIn walls article discovery from the droplet (HTTP 999), so a new article
only reaches the site if its address is handed over. This does the whole handover:

  1. validates each address (https://www.linkedin.com/pulse/<slug>; query/fragment/slash dropped)
  2. over SSH, appends it to the droplet's article-urls.txt (the LIVE list; sync-from-git unions it
     with git's copy, so nothing is lost on a redeploy)
  3. runs the sync once, right now, with --no-discover (no extra requests to the walled profile page)
  4. waits until https://motethansen.com/api/writing lists the article, and says so

Needs one environment variable, kept out of the repo (e.g. in ~/.zshenv):
  MOTETHANSEN_DROPLET_SSH   an SSH host alias for the droplet (~/.ssh/config)

Exit codes: 0 live (or already listed), 2 bad input/config, 3 droplet step failed,
4 synced but the site has not shown it within the wait (the hourly refresh will).
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from handoff_urls import validate  # noqa: E402  (same validation as the git-based handoff)

REMOTE_DIR = "/opt/motethansen-site/linkedin-sync"
FEED = "https://motethansen.com/api/writing?all=1"


def remote_script(urls):
    # urls passed validate(): https://www.linkedin.com/pulse/<slug>, so they hold no shell metacharacters
    # other than '-', '.', '_', '%' — and are single-quoted anyway.
    adds = "\n".join("grep -qxF '%s' article-urls.txt || echo '%s' >> article-urls.txt" % (u, u) for u in urls)
    return "set -e\ncd %s\n%s\nflock -w 900 /var/lock/linkedin-sync.lock docker compose run --rm sync --no-discover 2>&1 | tail -n 6\n" % (REMOTE_DIR, adds)


def on_site(urls):
    try:
        req = urllib.request.Request("%s&cb=%d" % (FEED, time.time()), headers={"User-Agent": "li-add"})
        posts = json.load(urllib.request.urlopen(req, timeout=20)).get("posts", [])
    except Exception:
        return set()
    have = {p.get("url", "").rstrip("/") for p in posts}
    return {u for u in urls if u in have}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urls", nargs="+", metavar="URL")
    ap.add_argument("--force", action="store_true", help="run the droplet step even if the site already lists it")
    ap.add_argument("--wait", type=int, default=150, help="seconds to wait for the site (default 150)")
    args = ap.parse_args(argv)

    try:
        urls = list(dict.fromkeys(validate(u) for u in args.urls))
    except ValueError as exc:
        print("rejected: %s" % exc, file=sys.stderr)
        return 2
    alias = os.environ.get("MOTETHANSEN_DROPLET_SSH")
    if not alias:
        print("MOTETHANSEN_DROPLET_SSH is not set (an SSH host alias for the droplet).", file=sys.stderr)
        return 2

    already = set() if args.force else on_site(urls)
    todo = [u for u in urls if u not in already]
    for u in already:
        print("already on the site: %s" % u)
    if not todo:
        return 0

    print("adding %d address(es) on the droplet and syncing…" % len(todo))
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", alias, "bash -s"], input=remote_script(todo),
                       universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    print(r.stdout.rstrip())
    if r.returncode != 0:
        print("droplet step failed (exit %d); nothing is live yet" % r.returncode, file=sys.stderr)
        return 3

    deadline = time.time() + args.wait
    while time.time() < deadline:
        live = on_site(todo)
        if live == set(todo):
            for u in todo:
                print("LIVE: %s" % u)
            return 0
        time.sleep(10)
    missing = [u for u in todo if u not in on_site(todo)]
    print("synced, but not on the site yet: %s\n(the feed refreshes hourly; it will appear by the next :00)"
          % ", ".join(missing), file=sys.stderr)
    return 4


if __name__ == "__main__":
    sys.exit(main())
