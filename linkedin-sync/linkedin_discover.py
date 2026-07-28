"""
linkedin_discover.py — find published article URLs from the PUBLIC profile page.

This is the piece that makes new LinkedIn articles appear on the site without
anyone pasting a URL.

Why this is possible at all: the member *activity listing*
(/in/<profile>/recent-activity/articles/) and the Voyager API are hard-walled,
which is what forced this job to be URL-driven. But that listing URL simply 301s
to the plain profile page (/in/<profile>/), and the profile page carries every
/pulse/ link in its HTML with **no login cookie**.

── Read this before "fixing" the retry logic ────────────────────────────────
The profile page is RATE LIMITED per source IP, and the limit is aggressive.
Measured 2026-07-28 on the droplet, all with identical requests:
  * early in the session          — 200 consistently
  * after ~30 requests            — 2/12 succeeded
  * after ~60 requests            — 0/12 succeeded (curl AND requests alike)
It recovers on its own once the IP goes quiet.

Three conclusions that are easy to get wrong, so they are written down:
  1. It is NOT a header/client fingerprint. curl, requests and urllib all behave
     the same at the same point in time. Chasing headers (Sec-Fetch, sec-ch-ua,
     Accept-Encoding) produces results that look causal but are just noise from
     a probabilistic wall — do not trust a single A/B here.
  2. It is NOT "datacentre IPs are blocked". The droplet reads this page fine
     when it hasn't been hammering. Cloudflare Workers egress, by contrast, is
     blocked outright.
  3. Therefore DO NOT poll this hourly. Frequent polling keeps the IP throttled
     and makes discovery *less* reliable, not more. Once or twice a day, with a
     few spaced retries, is the design point.

Discovery is best-effort by contract: the caller continues with the durable URL
list when it fails, so a throttled run degrades to "no new articles found today"
rather than breaking the metadata refresh.

Returns full article URLs; the caller fetches each one's metadata via
linkedin_public.py and MUST verify authorship (the profile page can surface other
people's posts).
"""

import random
import re
import time

import requests

PROFILE_URL_TMPL = "https://www.linkedin.com/in/{profile}/"

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

_PULSE_RE = re.compile(r"/pulse/([a-z0-9][a-z0-9-]*)", re.IGNORECASE)
# Only trust these on the FIRST few KB — a real profile page mentions "sign in"
# in its footer/nav, so scanning the whole document gives false positives.
_WALL_RE = re.compile(r"authwall|Sign in to view|challenge", re.IGNORECASE)
_WALL_SCAN_BYTES = 4000


class DiscoveryError(RuntimeError):
    """The profile page could not be fetched or was walled."""


def fetch_profile(profile, timeout=30, attempts=4, base_delay=20):
    """
    Fetch the public profile page HTML, retrying past the probabilistic wall.

    Retries are deliberately SPACED (tens of seconds, jittered), not tight: the
    wall is rate-limit driven, so hammering makes it worse. Four attempts over
    ~2 minutes is a good trade for a job that runs once or twice a day.
    """
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return _fetch_profile_once(profile, timeout=timeout)
        except DiscoveryError as exc:
            last = exc
            if attempt < attempts:
                delay = base_delay * attempt + random.uniform(0, base_delay)
                print(f"  discovery attempt {attempt}/{attempts} walled; "
                      f"retrying in {delay:.0f}s")
                time.sleep(delay)
    raise last


def _fetch_profile_once(profile, timeout=30):
    """One attempt. Raises DiscoveryError if walled."""
    url = PROFILE_URL_TMPL.format(profile=profile)
    try:
        resp = requests.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=timeout,
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        raise DiscoveryError(f"{url} -> {exc}") from exc

    # 999 is LinkedIn's anti-bot status; treat any non-200 as a wall.
    if resp.status_code != 200:
        why = ("rate-limited/anti-bot wall — this IP has been asking too often, "
               "it recovers when quiet") if resp.status_code == 999 else "unexpected status"
        raise DiscoveryError(f"{url} -> HTTP {resp.status_code} ({why})")

    html = resp.text
    if _WALL_RE.search(html[:_WALL_SCAN_BYTES]):
        raise DiscoveryError(f"{url} -> 200 but the page is an authwall, not the profile")
    return html


def extract_urls(html):
    """Return de-duplicated full article URLs found in profile page HTML."""
    seen, out = set(), []
    for m in _PULSE_RE.finditer(html):
        slug = m.group(1).lower()
        if slug in seen:
            continue
        seen.add(slug)
        out.append(f"https://www.linkedin.com/pulse/{slug}")
    return out


def discover_urls(profile, timeout=30):
    """
    Fetch the profile page and return the article URLs on it.

    Raises DiscoveryError on a wall/network failure, and also when the page loads
    but yields zero articles — that means LinkedIn changed the page shape, and
    silently returning [] would look identical to "no articles published".
    """
    urls = extract_urls(fetch_profile(profile, timeout=timeout))
    if not urls:
        raise DiscoveryError(
            "profile page loaded but contained 0 /pulse/ links — "
            "LinkedIn likely changed the page structure")
    return urls
