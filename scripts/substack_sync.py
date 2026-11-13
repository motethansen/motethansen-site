#!/usr/bin/env python3
"""Pull the two Substack publications and push them to the site (stdlib only, Python 3.9+).

Runs hourly on the mac-mini. Substack answers Cloudflare's addresses with HTTP 429 (sometimes for a day), so the
site cannot fetch the feeds itself; a home connection can. The feeds are read here and pushed to
POST https://motethansen.com/api/ingest/external, which upserts them into the article store (matching on the post
address, so re-running is harmless and nothing is ever deleted).

    substack_sync.py            # fetch both publications and push
    substack_sync.py --dry-run  # fetch and show what would be pushed

Token: $INGEST_TOKEN, else the first line of ~/.config/motethansen/ingest-token (mode 0600).
Exit code 0 = every publication pushed, 1 = at least one failed (the others are still pushed).
"""
import argparse
import email.utils
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ENDPOINT = os.environ.get("INGEST_URL", "https://motethansen.com/api/ingest/external")
PUBLICATIONS = {                      # source id (known to the service) -> feed
    "va-substack": "https://vizneoacademy.substack.com/feed",
    "ulw-substack": "https://urbanlifeworks.substack.com/feed",
}
UA = "Mozilla/5.0 (compatible; motethansen-substack-sync)"
NS = {"content": "http://purl.org/rss/1.0/modules/content/", "dc": "http://purl.org/dc/elements/1.1/"}


def strip_tags(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def parse_feed(xml_text):
    """RSS text -> list of {url, title, date (ISO 8601 UTC), description, image}. Items without a link or title are skipped."""
    root = ET.fromstring(xml_text)
    out = []
    for item in root.iter("item"):
        text = lambda tag: (item.findtext(tag) or "").strip()
        url, title = text("link"), text("title")
        if not url or not title:
            continue
        date = None
        try:
            date = email.utils.parsedate_to_datetime(text("pubDate")).astimezone(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (TypeError, ValueError):
            pass
        desc = strip_tags(text("description"))
        if not desc:
            desc = strip_tags(item.findtext("content:encoded", namespaces=NS))[:200]
        enc = item.find("enclosure")
        image = enc.get("url") if enc is not None and (enc.get("type") or "").startswith("image/") else None
        if not image:
            m = re.search(r'<img[^>]+src="([^"]+)"', item.findtext("content:encoded", namespaces=NS) or "")
            image = m.group(1) if m else None
        out.append({"url": url, "title": title, "date": date, "description": desc[:600], "image": image})
    return out


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def load_token():
    if os.environ.get("INGEST_TOKEN"):
        return os.environ["INGEST_TOKEN"].strip()
    path = os.path.expanduser("~/.config/motethansen/ingest-token")
    with open(path, "r", encoding="utf-8") as fh:
        return fh.readline().strip()


def push(source, entries, token, endpoint=ENDPOINT, timeout=60):
    body = json.dumps({"source": source, "entries": entries}).encode()
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def with_retry(fn, tries=3, wait=5):
    for i in range(tries):
        try:
            return fn()
        except (urllib.error.URLError, TimeoutError, ET.ParseError, OSError) as e:
            if i == tries - 1:
                raise
            time.sleep(wait * (i + 1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    token = None if args.dry_run else load_token()
    failed = 0
    for source, feed in PUBLICATIONS.items():
        try:
            entries = with_retry(lambda: parse_feed(fetch(feed)))
            if not entries:
                raise RuntimeError("feed had no items")
            if args.dry_run:
                print("%s: %d item(s); newest: %s (%s)" % (source, len(entries), entries[0]["title"], entries[0]["date"]))
                continue
            res = with_retry(lambda: push(source, entries, token))
            print("%s: pushed %d item(s): %d new, %d refreshed, %d skipped" % (source, len(entries), res["inserted"], res["updated"], len(res["skipped"])))
            for s in res["skipped"]:
                print("   skipped:", s)
        except Exception as e:  # noqa: BLE001 — report and carry on with the other publication
            failed += 1
            print("%s: FAILED: %s" % (source, e), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
