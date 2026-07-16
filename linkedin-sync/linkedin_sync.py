#!/usr/bin/env python3
"""
linkedin_sync.py — keep the website's LinkedIn articles up to date.

Pipeline:
    1. Collect LinkedIn articles      (linkedin_source.fetch_articles, or --from-file)
    2. Normalise to the post schema   (title, url, date, image, description)
    3. Merge with what's already in Cloudflare KV (union by URL — nothing is lost)
    4. Write the merged JSON array back to KV key `linkedin-posts-v1`

The Cloudflare Pages Function (functions/api/writing.js) and the feed-refresh
Worker both read that KV key and merge it with the live Substack feeds, so a new
LinkedIn article shows up on motethansen.com with no redeploy.

Runs anywhere Python 3.9+ runs — a DigitalOcean droplet cron, a DO App Platform
scheduled job, or a DO Function. See README.md.

Usage:
    python linkedin_sync.py                 # scrape LinkedIn -> merge -> push to KV
    python linkedin_sync.py --dry-run       # do everything except the KV write
    python linkedin_sync.py --from-file articles.json   # skip scraping, use a file
    python linkedin_sync.py --print         # print the current KV contents and exit

Config comes from environment variables (see .env.example):
    CF_ACCOUNT_ID          Cloudflare account id
    CF_KV_NAMESPACE_ID     KV namespace id (SITE_KV)  = 1b97cac1e10d4bcaaa1bef301a86af26
    CF_API_TOKEN           Cloudflare API token with "Workers KV Storage: Edit"
    LINKEDIN_PROFILE       public profile id, e.g. "michaelmotethansen"
    LINKEDIN_LI_AT         value of the li_at auth cookie (for scraping)
    LINKEDIN_JSESSIONID    value of the JSESSIONID cookie (optional, improves reliability)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import requests

KV_KEY = "linkedin-posts-v1"
MAX_ARTICLES = 60  # bound the KV value size; the site only ever shows a slice
CF_API = "https://api.cloudflare.com/client/v4"


# ── Config ────────────────────────────────────────────

def load_env():
    """Load .env if python-dotenv is available, then read config from the env."""
    try:
        from dotenv import load_dotenv  # optional convenience
        load_dotenv()
    except Exception:
        pass
    return {
        "account_id": os.environ.get("CF_ACCOUNT_ID", ""),
        "namespace_id": os.environ.get("CF_KV_NAMESPACE_ID", ""),
        "api_token": os.environ.get("CF_API_TOKEN", ""),
        "profile": os.environ.get("LINKEDIN_PROFILE", "michaelmotethansen"),
        "li_at": os.environ.get("LINKEDIN_LI_AT", ""),
        "jsessionid": os.environ.get("LINKEDIN_JSESSIONID", ""),
    }


# ── Normalisation ─────────────────────────────────────

def normalise(article):
    """
    Coerce one raw article dict into the site's post schema.
    Returns None if it lacks the required title + url.
    """
    title = (article.get("title") or "").strip()
    url = (article.get("url") or "").strip()
    if not title or not url:
        return None

    return {
        "title": title,
        "url": url.split("?")[0],  # drop tracking query params for stable dedupe
        "date": normalise_date(article.get("date")),
        "image": (article.get("image") or None),
        "description": (article.get("description") or "").strip()[:200],
    }


def normalise_date(value):
    """Accept ms-epoch ints, ISO strings, or 'YYYY-MM-DD' -> 'YYYY-MM-DD'."""
    if value is None or value == "":
        return ""
    # Epoch milliseconds (LinkedIn's usual format)
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        ms = int(value)
        if ms > 10_000_000_000:  # milliseconds, not seconds
            ms //= 1000
        return datetime.fromtimestamp(ms, tz=timezone.utc).strftime("%Y-%m-%d")
    # Already a date/ISO string
    text = str(value)
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(text[:len(fmt) + 2], fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text[:10]  # last resort: first 10 chars, hopefully YYYY-MM-DD


def merge(existing, scraped):
    """
    Union existing + scraped by URL. Scraped entries win on conflict (fresher
    metadata), but any existing article the scraper didn't return is preserved,
    so a partial scrape never deletes history.
    """
    by_url = {}
    for post in existing + scraped:  # scraped last => overrides
        if post and post.get("url"):
            by_url[post["url"]] = post
    merged = list(by_url.values())
    merged.sort(key=lambda p: p.get("date") or "", reverse=True)
    return merged[:MAX_ARTICLES]


# ── Cloudflare KV ─────────────────────────────────────

def kv_url(cfg):
    return (f"{CF_API}/accounts/{cfg['account_id']}"
            f"/storage/kv/namespaces/{cfg['namespace_id']}/values/{KV_KEY}")


def kv_read(cfg):
    """Return the current KV array, or [] if the key is missing/empty."""
    resp = requests.get(kv_url(cfg),
                        headers={"Authorization": f"Bearer {cfg['api_token']}"},
                        timeout=30)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    try:
        data = resp.json()
        return data if isinstance(data, list) else []
    except ValueError:
        return []


def kv_write(cfg, posts):
    """Overwrite the KV key with the given list (as JSON)."""
    resp = requests.put(
        kv_url(cfg),
        headers={
            "Authorization": f"Bearer {cfg['api_token']}",
            "Content-Type": "application/json",
        },
        data=json.dumps(posts, ensure_ascii=False),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


# ── Errors ────────────────────────────────────────────

class ConfigError(RuntimeError):
    """Missing/invalid configuration (env vars, input file)."""


class ScrapeEmptyError(RuntimeError):
    """The scrape returned 0 articles — treated as failure, not 'no articles'."""


# ── Pipeline ──────────────────────────────────────────

def collect_articles(cfg, args):
    # Offline replay of a previous --capture, no network.
    if args.from_capture:
        import linkedin_source
        return linkedin_source.fetch_from_capture(args.from_capture)
    # Hand-maintained / seed JSON file.
    if args.from_file:
        with open(args.from_file, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, list):
            raise ConfigError(f"{args.from_file} must contain a JSON array of articles")
        return raw
    # Live scrape. Import lazily so --from-file / --print work without scraping deps.
    import linkedin_source
    return linkedin_source.fetch_articles(
        profile=cfg["profile"], li_at=cfg["li_at"], jsessionid=cfg["jsessionid"],
        engine=args.engine, capture_dir=args.capture)


def _offline(args):
    """True for input paths that must never alert or trigger the empty-scrape guard."""
    return bool(args.from_file or args.from_capture)


# cfg key -> the env var the user actually sets
ENV_NAMES = {
    "account_id": "CF_ACCOUNT_ID",
    "namespace_id": "CF_KV_NAMESPACE_ID",
    "api_token": "CF_API_TOKEN",
    "profile": "LINKEDIN_PROFILE",
    "li_at": "LINKEDIN_LI_AT",
    "jsessionid": "LINKEDIN_JSESSIONID",
}


def require(cfg, keys):
    missing = [k for k in keys if not cfg[k]]
    if missing:
        raise ConfigError("missing required env vars: "
                          + ", ".join(ENV_NAMES.get(k, k.upper()) for k in missing))


def run(cfg, args):
    """
    Core pipeline: collect -> normalise -> merge -> (write). Returns the merged
    list. Raises ConfigError / ScrapeEmptyError / requests errors on failure so
    the caller can decide whether to alert.
    """
    raw = collect_articles(cfg, args)
    scraped = [p for p in (normalise(a) for a in raw) if p]
    source = "capture" if args.from_capture else "file" if args.from_file else "LinkedIn"
    print(f"collected {len(scraped)} article(s) from {source}")

    if not scraped and not _offline(args):
        # A scrape that returns nothing is almost always a login/anti-bot wall,
        # not "no articles" — never let that wipe the stored list.
        raise ScrapeEmptyError(
            "LinkedIn returned 0 articles — refusing to touch KV "
            "(likely an expired li_at cookie or an anti-bot challenge)")

    require(cfg, ["account_id", "namespace_id", "api_token"])
    existing = kv_read(cfg)
    merged = merge(existing, scraped)
    print(f"KV had {len(existing)} article(s); merged -> {len(merged)} "
          f"({len(merged) - len(existing):+d})")

    if args.dry_run:
        print("--dry-run: not writing. Result would be:")
        print(json.dumps(merged, indent=2, ensure_ascii=False))
        return merged

    kv_write(cfg, merged)
    print(f"wrote {len(merged)} article(s) to KV key '{KV_KEY}'")
    return merged


# ── CLI ───────────────────────────────────────────────

def parse_args():
    ap = argparse.ArgumentParser(description="Sync LinkedIn articles into Cloudflare KV.")
    ap.add_argument("--from-file", metavar="PATH",
                    help="load articles from a JSON file instead of scraping LinkedIn")
    ap.add_argument("--from-capture", metavar="DIR",
                    help="parse articles from a previous --capture dir, offline (no network)")
    ap.add_argument("--capture", metavar="DIR",
                    help="save every raw LinkedIn response to DIR for inspection")
    ap.add_argument("--engine", choices=["auto", "http", "playwright"], default="auto",
                    help="LinkedIn fetch engine (default: auto = HTTP, then Playwright fallback)")
    ap.add_argument("--dry-run", action="store_true",
                    help="do everything except the KV write; print the result")
    ap.add_argument("--print", dest="print_only", action="store_true",
                    help="print the current KV contents and exit")
    ap.add_argument("--test-alert", action="store_true",
                    help="send a test failure-alert email and exit (checks Resend config)")
    return ap.parse_args()


def main():
    args = parse_args()
    cfg = load_env()

    if args.print_only:
        try:
            require(cfg, ["account_id", "namespace_id", "api_token"])
            print(json.dumps(kv_read(cfg), indent=2, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            sys.exit(f"error: {exc}")
        return

    if args.test_alert:
        import notify
        ok = notify.send_failure(
            "test alert",
            "This is a test alert from `linkedin_sync.py --test-alert`. "
            "If you received it, failure alerting is configured correctly.")
        sys.exit(0 if ok else 1)

    # Only a real scheduled scrape emails on failure; manual --dry-run / offline
    # runs surface the error to the operator at the terminal instead.
    live_scrape = not _offline(args) and not args.dry_run
    try:
        run(cfg, args)
    except Exception as exc:  # noqa: BLE001 — top-level: report, alert, exit non-zero
        print(f"error: {exc}", file=sys.stderr)
        if live_scrape:
            import notify
            notify.send_failure("sync run failed", f"{type(exc).__name__}: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
