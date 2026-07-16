"""
linkedin_source.py — fetch a member's published LinkedIn articles.

⚠️  THIS IS THE FRAGILE LAYER.  LinkedIn has no official, public API for reading
an individual's published articles, and it actively defends against scraping.
Whatever we do here can break when LinkedIn changes its markup or endpoints, or
when the auth cookie expires. Everything downstream (normalise / merge / push to
Cloudflare KV in linkedin_sync.py) is stable and well isolated from this file —
if LinkedIn changes, you only ever have to repair fetch_articles().

Auth: LinkedIn requires a logged-in session. Copy the `li_at` cookie (and
ideally `JSESSIONID`) from your browser's DevTools while logged in, and set them
as LINKEDIN_LI_AT / LINKEDIN_JSESSIONID. `li_at` lasts ~1 year but can be
invalidated by a password change or a security event — when the sync starts
returning 0 articles, refresh it first.

Two strategies are attempted, in order:
    1. Voyager REST  — LinkedIn's internal JSON API (needs the CSRF token).
    2. SSR HTML JSON-LD — parse <script type="application/ld+json"> blocks that
       the article/author pages sometimes embed.

If both come back empty we RAISE rather than return [] — an empty result almost
always means an auth wall, and linkedin_sync.py must not treat that as
"you have no articles" and wipe stored history.

Prefer not to maintain this at all? Two escape hatches that need no scraping:
    • Run `linkedin_sync.py --from-file articles.json` from a hand-kept JSON file.
    • Point a third-party LinkedIn->RSS bridge at your profile and parse that
      feed here instead (replace fetch_articles with an RSS parse).
"""

import json
import os
import re

import requests

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)


class LinkedInFetchError(RuntimeError):
    pass


def fetch_articles(profile, li_at, jsessionid="", engine="auto", capture_dir=None):
    """
    Return a list of raw article dicts: {title, url, date, image, description}.
    `date` may be epoch-ms or an ISO string — normalise_date() handles both.

    engine:
      "http"       — plain-HTTP strategies only (Voyager + JSON-LD).
      "playwright" — headless-browser engine only (see linkedin_playwright.py).
      "auto"       — HTTP first, fall back to Playwright if HTTP is walled.
    capture_dir: if set, every raw response is written there for offline
      inspection (see linkedin_sync.py --capture) — useful for diagnosing walls.
    Raises LinkedInFetchError if nothing could be fetched.
    """
    if not li_at:
        raise LinkedInFetchError(
            "LINKEDIN_LI_AT is not set — cannot authenticate to LinkedIn. "
            "Set it, or run with --from-file.")

    errors = []

    if engine in ("auto", "http"):
        try:
            articles = _fetch_via_http(profile, li_at, jsessionid, capture_dir)
            if articles:
                return articles
            errors.append("http: 0 articles")
        except Exception as exc:  # noqa: BLE001 — record; maybe fall back to Playwright
            errors.append(f"http: {exc}")
        if engine == "http":
            raise LinkedInFetchError(_no_articles_msg(errors))

    if engine in ("auto", "playwright"):
        try:
            import linkedin_playwright  # lazy — only needed for this engine
            articles = linkedin_playwright.fetch_articles(
                profile, li_at, jsessionid, capture_dir=capture_dir)
            if articles:
                return articles
            errors.append("playwright: 0 articles")
        except ImportError:
            errors.append("playwright: engine not installed "
                          "(pip install -r requirements-playwright.txt)")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"playwright: {exc}")

    raise LinkedInFetchError(_no_articles_msg(errors))


def _no_articles_msg(errors):
    return ("No articles returned by any strategy. This usually means the li_at "
            "cookie is expired or LinkedIn served an anti-bot challenge. Details:\n  "
            + "\n  ".join(errors or ["(all strategies returned empty)"]))


def _fetch_via_http(profile, li_at, jsessionid, capture_dir=None):
    """Plain-HTTP strategies: Voyager REST, then SSR HTML JSON-LD."""
    session = _session(li_at, jsessionid)
    errors = []
    for strategy in (_fetch_via_voyager, _fetch_via_html):
        try:
            articles = strategy(session, profile, capture_dir)
            if articles:
                return articles
        except Exception as exc:  # noqa: BLE001 — record and try the next strategy
            errors.append(f"{strategy.__name__}: {exc}")
    if errors:
        raise LinkedInFetchError("; ".join(errors))
    return []


# ── Offline replay ────────────────────────────────────

def fetch_from_capture(capture_dir):
    """
    Parse articles from a previously captured directory (see --capture), with no
    network. Lets us iterate the parsers against real LinkedIn output offline.
    """
    articles = []
    voyager_json = _read(capture_dir, "voyager.json")
    if voyager_json:
        try:
            articles += _parse_voyager(json.loads(voyager_json))
        except ValueError:
            pass
    for name in ("author.html", "playwright.html"):
        html = _read(capture_dir, name)
        if html:
            articles += _parse_html(html)
    # de-dupe by url, preserve order
    seen, out = set(), []
    for a in articles:
        u = a.get("url")
        if u and u not in seen:
            seen.add(u)
            out.append(a)
    return out


# ── Capture helpers ───────────────────────────────────

def _save(capture_dir, name, text, status=None):
    """Write a raw response to capture_dir/name (best-effort; never raises)."""
    if not capture_dir:
        return
    try:
        os.makedirs(capture_dir, exist_ok=True)
        with open(os.path.join(capture_dir, name), "w", encoding="utf-8") as fh:
            fh.write(text or "")
        if status is not None:
            with open(os.path.join(capture_dir, name + ".status"), "w") as fh:
                fh.write(str(status))
    except Exception as exc:  # noqa: BLE001
        print(f"capture: failed to save {name}: {exc}")


def _read(capture_dir, name):
    path = os.path.join(capture_dir, name)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


# ── Session ───────────────────────────────────────────

def _session(li_at, jsessionid):
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
    })
    s.cookies.set("li_at", li_at, domain=".linkedin.com")
    if jsessionid:
        # JSESSIONID is stored quoted; the CSRF header must match it verbatim.
        quoted = jsessionid if jsessionid.startswith('"') else f'"{jsessionid}"'
        s.cookies.set("JSESSIONID", quoted, domain=".linkedin.com")
        s.headers["csrf-token"] = quoted.strip('"')
    return s


# ── Strategy 1: Voyager REST ──────────────────────────

def _fetch_via_voyager(session, profile, capture_dir=None):
    """
    Query LinkedIn's internal Voyager API for the member's articles.

    Endpoint shapes drift over time; this uses the member-creator content feed.
    If LinkedIn returns a 999/403 or an unexpected shape, we raise and the caller
    falls through to the HTML strategy.
    """
    url = (
        "https://www.linkedin.com/voyager/api/identity/profile/"
        f"{profile}/posts"
    )
    resp = session.get(
        url,
        headers={
            "x-restli-protocol-version": "2.0.0",
            "Accept": "application/vnd.linkedin.normalized+json+2.1",
        },
        params={"q": "memberShareFeed", "count": 50, "start": 0},
        timeout=30,
    )
    _save(capture_dir, "voyager.json", resp.text, resp.status_code)
    if resp.status_code != 200:
        raise LinkedInFetchError(f"voyager HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError:
        raise LinkedInFetchError("voyager: non-JSON response (likely a challenge)")
    return _parse_voyager(data)


def _parse_voyager(data):
    """Extract pulse articles from a Voyager JSON payload."""
    elements = data.get("elements") or data.get("included") or []
    articles = []
    for el in elements:
        art = _article_from_voyager(el)
        if art:
            articles.append(art)
    return articles


def _article_from_voyager(el):
    """Best-effort extraction of a pulse article from a Voyager element."""
    if not isinstance(el, dict):
        return None
    # Only keep long-form articles (their permalink lives under /pulse/).
    url = _first_str(el, ["permalink", "articleUrl", "url"])
    if not url or "/pulse/" not in url:
        return None
    title = _first_str(el, ["title", "articleTitle"]) or ""
    if isinstance(title, dict):
        title = title.get("text", "")
    return {
        "title": title,
        "url": url,
        "date": _first_str(el, ["publishedAt", "createdAt", "firstPublishedAt"]),
        "image": _first_str(el, ["coverImage", "image"]),
        "description": _first_str(el, ["subtitle", "description", "summary"]) or "",
    }


# ── Strategy 2: SSR HTML JSON-LD ──────────────────────

def _fetch_via_html(session, profile, capture_dir=None):
    """
    Fetch the author's public article listing and parse JSON-LD from it. Works
    when LinkedIn serves server-rendered content; returns [] (caller raises) when
    it serves only a JS shell / login wall.
    """
    url = f"https://www.linkedin.com/today/author/{profile}"
    resp = session.get(url, timeout=30)
    _save(capture_dir, "author.html", resp.text, resp.status_code)
    if resp.status_code != 200:
        raise LinkedInFetchError(f"html HTTP {resp.status_code}")
    return _parse_html(resp.text)


def _parse_html(html):
    """Extract articles from JSON-LD <script> blocks in a LinkedIn HTML page."""
    articles = []
    for block in re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.S
    ):
        try:
            payload = json.loads(block.strip())
        except ValueError:
            continue
        for node in _iter_ldjson(payload):
            if node.get("@type") in ("BlogPosting", "Article", "NewsArticle"):
                articles.append({
                    "title": (node.get("headline") or node.get("name") or "").strip(),
                    "url": node.get("url") or _first_str(node, ["mainEntityOfPage"]),
                    "date": node.get("datePublished") or node.get("dateCreated"),
                    "image": _ldjson_image(node),
                    "description": (node.get("description") or "").strip(),
                })
    return [a for a in articles if a.get("url")]


def _iter_ldjson(payload):
    """Yield dict nodes from a JSON-LD payload (object, list, or @graph)."""
    if isinstance(payload, list):
        for item in payload:
            yield from _iter_ldjson(item)
    elif isinstance(payload, dict):
        if "@graph" in payload and isinstance(payload["@graph"], list):
            yield from _iter_ldjson(payload["@graph"])
        else:
            yield payload


def _ldjson_image(node):
    img = node.get("image")
    if isinstance(img, dict):
        return img.get("url")
    if isinstance(img, list) and img:
        first = img[0]
        return first.get("url") if isinstance(first, dict) else first
    return img if isinstance(img, str) else None


# ── helpers ───────────────────────────────────────────

def _first_str(obj, keys):
    for k in keys:
        v = obj.get(k)
        if isinstance(v, (str, int)) and v != "":
            return v
    return None
