"""
linkedin_public.py — fetch a published LinkedIn article's metadata from its
PUBLIC page, by URL. No login cookie, no internal API.

Why this exists: LinkedIn walls the member *activity listing*
(/in/<profile>/recent-activity/articles/ → HTTP 999) from datacentre IPs, so the
cookie scraper can't enumerate articles from the droplet. But an *individual*
published article is a public page (anyone can read it), and it carries clean
Open Graph + JSON-LD metadata. So instead of scraping the walled list, we fetch
each article by URL and read its <meta> tags — reliable, cookie-free, and within
what any link-preview bot does.

Discovery of a brand-new article's URL is the one manual step (see article-urls.txt
and `--url`); everything downstream stays automatic.

Returns raw article dicts in the same shape linkedin_sync.normalise() expects:
    {title, url, date, image, description}
"""

import re
import requests

# A normal browser UA — public article pages serve fine to these; the 999 wall
# is on the activity listing, not on individual /pulse/ articles.
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")


class PublicFetchError(RuntimeError):
    """A single article URL could not be fetched/parsed."""


def _meta(html, prop):
    """Return the content of <meta property="prop"> (og:*/article:*), or ''.

    The content delimiter is captured and back-referenced (\\2) so an apostrophe
    inside a double-quoted value (e.g. og:title "Why We're …") doesn't truncate
    the match — a naive [^"']* class would stop at the first apostrophe.
    """
    p = re.escape(prop)
    # property/content order varies, so match both arrangements. In each pattern
    # the value is the named group `val`, delimited by its own captured quote so
    # an apostrophe inside a double-quoted value doesn't truncate it.
    for pat in (
        rf'<meta[^>]+property=(["\']){p}\1[^>]+content=(?P<q>["\'])(?P<val>.*?)(?P=q)',
        rf'<meta[^>]+content=(?P<q>["\'])(?P<val>.*?)(?P=q)[^>]+property=(["\']){p}\3',
    ):
        m = re.search(pat, html, re.IGNORECASE | re.DOTALL)
        if m:
            return _unescape(m.group("val")).strip()
    return ""


def _json_ld_date(html):
    """Pull the first JSON-LD datePublished (richer than og for the date)."""
    m = re.search(r'"datePublished"\s*:\s*"([^"]+)"', html)
    return m.group(1) if m else ""


def _json_ld_author(html):
    """
    Pull the JSON-LD author name, e.g. "Michael Hansen, PhD".

    Needed by the discovery path: the public profile page can surface OTHER
    people's articles, and publishing one of those as the site owner's would be
    a real misattribution. The author object nests (it carries an `image` and an
    `interactionStatistic` sub-object), so allow one level of nesting before
    "name" rather than using a naive [^}]* class.
    """
    m = re.search(r'"author"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"name"\s*:\s*"([^"]+)"',
                  html, re.DOTALL)
    return _unescape(m.group(1)).strip() if m else ""


def _unescape(text):
    import html as _h
    return _h.unescape(text)


def fetch_article(url, timeout=30):
    """Fetch one public article page and extract its metadata dict.

    Raises PublicFetchError on a non-200 response or a page with no usable title
    (e.g. an authwall/999 — which shouldn't happen for a real /pulse/ URL, but we
    fail loudly rather than store an empty article).
    """
    url = url.strip()
    resp = requests.get(url, headers={"User-Agent": USER_AGENT},
                        timeout=timeout, allow_redirects=True)
    if resp.status_code != 200:
        raise PublicFetchError(f"{url} -> HTTP {resp.status_code}")

    html = resp.text
    title = _meta(html, "og:title")
    if not title:
        # No og:title means we didn't get a real article page (wall/redirect).
        raise PublicFetchError(
            f"{url} -> 200 but no og:title (likely an authwall or a non-article page)")

    return {
        "title": title,
        # Prefer the canonical og:url, fall back to the requested URL.
        "url": _meta(html, "og:url") or url,
        "date": _json_ld_date(html) or _meta(html, "article:published_time"),
        "image": _meta(html, "og:image") or None,
        "description": _meta(html, "og:description"),
        # Consumed by the discovery authorship guard in linkedin_sync; normalise()
        # builds the site schema explicitly, so this extra key never reaches KV.
        "author": _json_ld_author(html),
    }


def fetch_articles(urls):
    """Fetch many article URLs. Returns (articles, errors).

    Partial success is fine: a URL that fails is collected in `errors` and skipped
    — the caller merges what succeeded into KV (merge never drops existing posts),
    so one dead URL never wipes the stored list.
    """
    articles, errors = [], []
    for raw in urls:
        u = raw.strip()
        if not u or u.startswith("#"):
            continue
        try:
            articles.append(fetch_article(u))
            print(f"  ok   {u}")
        except Exception as exc:  # noqa: BLE001 — report per-URL, keep going
            errors.append((u, str(exc)))
            print(f"  FAIL {u} -> {exc}")
    return articles, errors
