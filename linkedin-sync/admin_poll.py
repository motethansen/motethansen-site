#!/usr/bin/env python3
"""Droplet side of the /admin page: pick up queued LinkedIn article addresses and publish them.

The Pages Function (functions/api/admin/add.js) writes one KV key per submission:
    linkedin-pending:<id>       {"url": ..., "requestedAt": ...}
    linkedin-add-status:<id>    {"state": "queued", ...}          (what the page watches)

A Pages Function cannot reach this host and LinkedIn walls fetches from Cloudflare, so this polls (a systemd
timer, every minute; an empty poll is one cheap API call) and, when something is queued:

  1. validates each address again (the droplet never fetches anything but linkedin.com/pulse/<slug>)
  2. appends new ones to article-urls.txt, the live list the scheduled job also reads
  3. runs the sync once with --no-discover (no extra requests to the walled profile page); the sync
     merges into KV and pings the feed-refresh Worker, so the site rebuilds right away
  4. confirms the article is in KV, waits briefly for the live site to list it, and writes the result
     to linkedin-add-status:<id>; then deletes the pending keys

One attempt per submission, success or not: a failure is reported on the page and the address can be
submitted again. Exit 0 always for "nothing to do"; non-zero only when this script itself breaks.

Runs under the same lock as the scheduled job (deploy/docker-run.sh) so two syncs never merge into KV at once.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CF_API = "https://api.cloudflare.com/client/v4"
PENDING_PREFIX = "linkedin-pending:"
STATUS_PREFIX = "linkedin-add-status:"
POSTS_KEY = "linkedin-posts-v1"
SITE_FEED = "https://motethansen.com/api/writing?all=1"
LOCK_PATH = "/var/lock/linkedin-sync.lock"
ARTICLE_RE = re.compile(r"^https://www\.linkedin\.com/pulse/([A-Za-z0-9-]{3,300})$")
SYNC_TIMEOUT_S = 900
SITE_WAIT_S = 75
STATUS_TTL_S = 7 * 86400
POLLER_STATUS_KEY = "linkedin-poll-status-v1"      # read by GET /api/health (shared/health-core.js)
HEARTBEAT_EVERY_S = 600                            # 144 KV writes/day; the poll itself runs every minute
HEARTBEAT_FILE = "/var/tmp/linkedin-admin-poll.heartbeat"


def load_env(path):
    env = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env


class KV:
    """Minimal Cloudflare KV client (stdlib only: the droplet's system python has no `requests`)."""

    def __init__(self, env):
        self.base = "%s/accounts/%s/storage/kv/namespaces/%s" % (CF_API, env["CF_ACCOUNT_ID"], env["CF_KV_NAMESPACE_ID"])
        self.token = env["CF_API_TOKEN"]

    def _req(self, method, path, data=None, ctype=None, query=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        headers = {"Authorization": "Bearer " + self.token}
        if ctype:
            headers["Content-Type"] = ctype
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def list_keys(self, prefix):
        body = self._req("GET", "/keys", query={"prefix": prefix, "limit": 100})
        return [k["name"] for k in json.loads(body)["result"]] if body else []

    def get_json(self, key):
        body = self._req("GET", "/values/" + urllib.parse.quote(key, safe=""))
        if body is None:
            return None
        try:
            return json.loads(body)
        except ValueError:
            return None

    def put_json(self, key, value, ttl=None):
        self._req("PUT", "/values/" + urllib.parse.quote(key, safe=""), json.dumps(value).encode(),
                  "application/json", {"expiration_ttl": ttl} if ttl else None)

    def delete(self, key):
        self._req("DELETE", "/values/" + urllib.parse.quote(key, safe=""))


def slug(url):
    m = ARTICLE_RE.match(url or "")
    return m.group(1).lower() if m else ""


def site_lists(url, wait_s=SITE_WAIT_S, fetch=None):
    """Poll the live feed until it lists the article; False if it does not within wait_s."""
    def default_fetch():
        req = urllib.request.Request("%s&cb=%d" % (SITE_FEED, time.time()), headers={"User-Agent": "admin-poll"})
        return json.load(urllib.request.urlopen(req, timeout=20)).get("posts", [])
    fetch = fetch or default_fetch
    deadline = time.time() + wait_s
    while True:
        try:
            if any(slug(p.get("url", "").rstrip("/")) == slug(url) for p in fetch()):
                return True
        except Exception:
            pass
        if time.time() >= deadline:
            return False
        time.sleep(5)


def append_urls(path, urls):
    have = set()
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            have = {ln.strip().rstrip("/") for ln in fh}
    new = [u for u in urls if u not in have]
    if new:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("".join(u + "\n" for u in new))
    return new


def remove_urls(path, urls):
    """Take addresses back out of the list (a typo must not be retried by every scheduled run)."""
    drop = {u.rstrip("/") for u in urls}
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(ln for ln in lines if ln.strip().rstrip("/") not in drop)


def run_sync():
    """One container pass. Returns (returncode, tail of output)."""
    r = subprocess.run(["docker", "compose", "run", "--rm", "sync", "--no-discover"], cwd=HERE,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=SYNC_TIMEOUT_S)
    return r.returncode, "\n".join(r.stdout.strip().splitlines()[-8:])


def process(kv, urls_path, run=run_sync, listed=site_lists, now=time.time):
    """Handle everything queued. Returns the number of submissions handled."""
    keys = kv.list_keys(PENDING_PREFIX)
    if not keys:
        return 0
    jobs = []                                                  # (id, url) that passed validation
    for key in keys:
        jid = key[len(PENDING_PREFIX):]
        rec = kv.get_json(key) or {}
        url = (rec.get("url") or "").rstrip("/")
        if not ARTICLE_RE.match(url):
            kv.put_json(STATUS_PREFIX + jid, {"state": "failed", "url": url[:200], "ts": int(now()),
                                              "reason": "That is not a LinkedIn article address."}, STATUS_TTL_S)
            kv.delete(key)
            continue
        kv.put_json(STATUS_PREFIX + jid, {"state": "syncing", "url": url, "ts": int(now())}, STATUS_TTL_S)
        jobs.append((jid, url, key))
    if not jobs:
        return len(keys)

    reason = None
    appended = []
    try:
        appended = append_urls(urls_path, [u for _, u, _ in jobs])
        code, tail = run()
        if code != 0:
            reason = "The sync job failed (exit %d). %s" % (code, tail[-250:])
    except subprocess.TimeoutExpired:
        reason = "The sync job timed out."
    except Exception as exc:                                    # noqa: BLE001 — report it on the page, keep going
        reason = "The sync job could not run: %s" % exc

    posts = kv.get_json(POSTS_KEY) or []
    by_slug = {slug(p.get("url", "").rstrip("/")): p for p in posts}
    for jid, url, key in jobs:
        post = by_slug.get(slug(url))
        if post:
            on_site = listed(url)
            rec = {"state": "published", "url": url, "title": post.get("title"), "ts": int(now())}
            if not on_site:
                rec["reason"] = "Saved. The site's cache refreshes at the top of the hour at the latest."
        else:
            rec = {"state": "failed", "url": url, "ts": int(now()),
                   "reason": reason or "LinkedIn did not return that article's details. Check the address and try again."}
        kv.put_json(STATUS_PREFIX + jid, rec, STATUS_TTL_S)
        kv.delete(key)
        if rec["state"] == "failed" and url in appended:
            remove_urls(urls_path, [url])
    return len(keys)


def heartbeat(kv, path=HEARTBEAT_FILE, now=time.time, every_s=HEARTBEAT_EVERY_S):
    """Tell /api/health this poller is alive. Throttled by a local file so a per-minute poll costs 1 write per 10 min."""
    t = now()
    try:
        if t - os.path.getmtime(path) < every_s:
            return False
    except OSError:
        pass
    kv.put_json(POLLER_STATUS_KEY, {"ts": int(t)}, 86400)
    with open(path, "w") as fh:
        fh.write(str(int(t)))
    return True


def main():
    env = load_env(os.path.join(HERE, ".env"))
    kv = KV(env)
    lock = open(LOCK_PATH, "w")
    # Cheap check first so an empty poll never waits for (or holds) the lock. Reaching KV and listing
    # successfully is what the heartbeat vouches for, so it is written only after that call works.
    queued = kv.list_keys(PENDING_PREFIX)
    try:
        heartbeat(kv)
    except Exception as exc:                                    # noqa: BLE001 — never let a heartbeat block publishing
        print("heartbeat not written: %s" % exc, file=sys.stderr)
    if not queued:
        return 0
    fcntl.flock(lock, fcntl.LOCK_EX)
    n = process(kv, os.path.join(HERE, "article-urls.txt"))
    print("handled %d submission(s)" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
