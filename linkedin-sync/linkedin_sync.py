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
import re
import sys
from datetime import datetime, timezone

import requests

KV_KEY = "linkedin-posts-v1"
MAX_ARTICLES = 60  # bound the KV value size; the site only ever shows a slice
CF_API = "https://api.cloudflare.com/client/v4"
# Durable list of your published article URLs (one per line, # for comments).
# The scheduled run reads this by default and re-fetches each article's public
# metadata; adding a new article = append its URL (see --url).
DEFAULT_URLS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "article-urls.txt")


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
        # Authorship guard for discovered articles — a regex matched against the
        # article's JSON-LD author name. Empty disables the check (not advised:
        # the profile page can surface other people's posts).
        "author_match": os.environ.get("LINKEDIN_AUTHOR_MATCH", "hansen"),
        # Optional: ping the feed-refresh Worker after a KV write so the site
        # updates in seconds instead of waiting for its hourly cron.
        "refresh_url": os.environ.get("FEED_REFRESH_URL", ""),
        "refresh_secret": os.environ.get("FEED_REFRESH_SECRET", ""),
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
    # URL-driven public fetch — the primary path. Reads article URLs from --url
    # and/or a urls file, plus anything discovered on the public profile page,
    # then fetches each article's public metadata (no cookie).
    urls, discovered = _resolve_urls(args, cfg)
    if urls is not None:
        import linkedin_public
        articles, errors = linkedin_public.fetch_articles(urls)
        if errors and not articles:
            # Every URL failed — surface it (likely a network/block issue) rather
            # than silently proceeding to a no-op merge.
            raise ScrapeEmptyError(
                "all article URLs failed to fetch:\n  "
                + "\n  ".join(f"{u}: {e}" for u, e in errors))
        articles = _keep_owner_articles(articles, discovered, cfg)
        # Record only URLs that fetched AND passed the authorship guard, so a
        # transient failure or someone else's post never pollutes the durable list.
        if discovered:
            confirmed = [u for u in discovered if _slug(u) in {_slug(a["url"]) for a in articles}]
            if confirmed:
                _append_urls(args.urls_file, confirmed)
        return articles
    # Legacy cookie scrape (kept for completeness; LinkedIn walls the listing
    # from datacentre IPs, so this usually returns nothing there). Import lazily.
    import linkedin_source
    return linkedin_source.fetch_articles(
        profile=cfg["profile"], li_at=cfg["li_at"], jsessionid=cfg["jsessionid"],
        engine=args.engine, capture_dir=args.capture)


def _slug(url):
    """The stable /pulse/<slug> identity of an article URL ('' if not one)."""
    m = re.search(r"/pulse/([a-z0-9][a-z0-9-]*)", (url or ""), re.IGNORECASE)
    return m.group(1).lower() if m else ""


def _resolve_urls(args, cfg):
    """Return (urls_to_fetch, discovered_urls) — or (None, set()) for a scrape run.

    Sources, in order: URLs discovered on the public profile page, explicit --url
    values, an explicit --urls-file, else DEFAULT_URLS_FILE if it exists (so the
    scheduled run just works). Returns None only when there are no URLs anywhere
    and no scrape-suppressing flags — i.e. fall back to the legacy scrape.

    Discovery is what lets a NEWLY published article reach the site with no manual
    step. It is best-effort: if LinkedIn walls this network the run continues with
    the durable list, because a discovery outage must not stop the metadata
    refresh for articles we already know about.
    """
    discovered = []
    if not args.no_discover:
        import linkedin_discover
        try:
            discovered = linkedin_discover.discover_urls(cfg["profile"])
            print(f"discovered {len(discovered)} article URL(s) on the public profile page")
        except linkedin_discover.DiscoveryError as exc:
            print(f"discovery unavailable ({exc}) — continuing with the durable URL list")

    urls = list(discovered) + list(args.url or [])
    path = args.urls_file or (DEFAULT_URLS_FILE if os.path.exists(DEFAULT_URLS_FILE) else None)
    if path:
        if not os.path.exists(path):
            raise ConfigError(f"--urls-file not found: {path}")
        with open(path, "r", encoding="utf-8") as fh:
            urls += [ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith("#")]
    if not urls:
        return None, set()
    # De-dupe by article identity, preserving order. Keying on the slug (not the
    # raw string) stops a trailing-slash variant being fetched twice.
    seen, out = set(), []
    for u in urls:
        key = _slug(u) or u
        if key not in seen:
            seen.add(key); out.append(u)
    return out, set(discovered)


def _keep_owner_articles(articles, discovered, cfg):
    """
    Drop discovered articles that someone else wrote.

    The public profile page surfaces reshares and recommendations, so a /pulse/
    link on it is not proof of authorship. Articles from the curated list are
    trusted as-is — only discovered ones are screened. An article with no JSON-LD
    author falls back to requiring the owner's name in the URL slug, since
    LinkedIn builds article slugs from the author's name.
    """
    if not discovered:
        return articles
    pattern = cfg.get("author_match") or ""
    discovered_slugs = {_slug(u) for u in discovered}
    kept = []
    for a in articles:
        slug = _slug(a.get("url", ""))
        if slug not in discovered_slugs:
            kept.append(a)                      # curated URL — trusted
            continue
        author = (a.get("author") or "").strip()
        haystack = author or slug
        if pattern and not re.search(pattern, haystack, re.IGNORECASE):
            print(f"  skip {a.get('url')} — author {author or '(unknown)'!r} "
                  f"does not match /{pattern}/i")
            continue
        kept.append(a)
    return kept


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
    if len(merged) != len(existing):
        _ping_refresh(cfg)
    return merged


def _ping_refresh(cfg):
    """
    Nudge the feed-refresh Worker to rebuild now.

    The site caches the merged feed, so without this a new article waits for the
    Worker's hourly cron. Best-effort by design: the KV write already succeeded
    and the cron is the backstop, so a failure here is logged, never raised.
    Only called when the article count actually changed — no point rebuilding
    the feed on the many runs that find nothing new.
    """
    url, secret = cfg.get("refresh_url"), cfg.get("refresh_secret")
    if not url or not secret:
        print("refresh ping skipped (FEED_REFRESH_URL/FEED_REFRESH_SECRET unset) — "
              "the site picks this up on the next hourly cron")
        return
    try:
        resp = requests.get(url, params={"secret": secret}, timeout=60)
        if resp.ok:
            body = resp.json()
            print(f"refreshed site feed now — {body.get('count')} posts live")
        else:
            print(f"refresh ping -> HTTP {resp.status_code} (hourly cron will catch up)")
    except Exception as exc:  # noqa: BLE001 — never fail the run over the ping
        print(f"refresh ping failed ({exc}) — hourly cron will catch up")


# ── CLI ───────────────────────────────────────────────

def parse_args():
    ap = argparse.ArgumentParser(description="Sync LinkedIn articles into Cloudflare KV.")
    ap.add_argument("--url", metavar="URL", action="append",
                    help="fetch this article's PUBLIC metadata by URL (repeatable); "
                         "does not modify article-urls.txt")
    ap.add_argument("--add-url", metavar="URL", action="append",
                    help="append URL(s) to article-urls.txt (the durable list) and "
                         "fetch them (repeatable). Use this when you publish a new article")
    ap.add_argument("--urls-file", metavar="PATH",
                    help=f"read article URLs from PATH (default: {os.path.basename(DEFAULT_URLS_FILE)} "
                         "if present)")
    ap.add_argument("--from-file", metavar="PATH",
                    help="load articles from a JSON file instead of scraping LinkedIn")
    ap.add_argument("--from-capture", metavar="DIR",
                    help="parse articles from a previous --capture dir, offline (no network)")
    ap.add_argument("--capture", metavar="DIR",
                    help="save every raw LinkedIn response to DIR for inspection")
    ap.add_argument("--no-discover", action="store_true",
                    help="skip public-profile discovery of new articles; use only "
                         "--url / the urls file")
    ap.add_argument("--engine", choices=["auto", "http", "playwright"], default="auto",
                    help="LinkedIn fetch engine (default: auto = HTTP, then Playwright fallback)")
    ap.add_argument("--dry-run", action="store_true",
                    help="do everything except the KV write; print the result")
    ap.add_argument("--print", dest="print_only", action="store_true",
                    help="print the current KV contents and exit")
    ap.add_argument("--test-alert", action="store_true",
                    help="send a test failure-alert email and exit (checks Resend config)")
    return ap.parse_args()


def _append_urls(paths, urls):
    """Append new URLs to the durable urls file (creating it), skipping dupes."""
    path = paths or DEFAULT_URLS_FILE
    existing = set()
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            existing = {ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith("#")}
    added = [u.strip() for u in urls if u.strip() and u.strip() not in existing]
    if added:
        with open(path, "a", encoding="utf-8") as fh:
            for u in added:
                fh.write(u + "\n")
        print(f"added {len(added)} URL(s) to {os.path.basename(path)}")
    else:
        print("no new URLs to add (already present)")


def main():
    args = parse_args()
    cfg = load_env()

    # --add-url: persist to the durable list first, so the run below (which reads
    # that file) picks them up. Also fetched this run via _resolve_urls.
    if args.add_url:
        _append_urls(args.urls_file, args.add_url)

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
