"""
linkedin_playwright.py — headless-browser fetch engine (the fallback).

Used by linkedin_source.fetch_articles when the plain-HTTP path is walled
(LinkedIn increasingly serves a JS shell / 999 challenge to datacenter IPs).
A real Chromium session with your li_at cookie looks like a browser, so it gets
the rendered articles page.

Lazy by design: the heavy `playwright` import happens inside fetch_articles(), so
`import linkedin_playwright` is cheap and HTTP-only installs never need Chromium.

Provisioning (droplet):  bash deploy/setup.sh --with-playwright
  → pip install -r requirements-playwright.txt
  → playwright install chromium && playwright install-deps

Extraction is two-tier:
  1. JSON-LD in the rendered HTML (reuses linkedin_source._parse_html) — richest.
  2. DOM fallback: collect <a href*="/pulse/"> article links + titles.
DOM dates/images are unreliable, so those come out blank (normalise tolerates an
empty date; such items just sort last). Repairs to selectors live only here.
"""

import linkedin_source as ls   # reuse _parse_html, _save, USER_AGENT

# The author's published-articles listing renders reliably with a logged-in session.
AUTHOR_URL = "https://www.linkedin.com/today/author/{profile}"


def fetch_articles(profile, li_at, jsessionid="", capture_dir=None, timeout_ms=45000):
    """Return raw article dicts via a headless Chromium session. Raises on failure."""
    from playwright.sync_api import sync_playwright  # lazy — ImportError if not installed

    url = AUTHOR_URL.format(profile=profile)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            context = browser.new_context(user_agent=ls.USER_AGENT, locale="en-US")
            context.add_cookies(_cookies(li_at, jsessionid))
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=timeout_ms)
            except Exception:  # noqa: BLE001 — networkidle is best-effort
                pass
            _autoscroll(page)

            html = page.content()
            ls._save(capture_dir, "playwright.html", html, 200)

            articles = ls._parse_html(html)      # JSON-LD, if present
            if not articles:
                articles = _extract_dom(page)    # DOM fallback
            return articles
        finally:
            browser.close()


def _cookies(li_at, jsessionid):
    cookies = [{"name": "li_at", "value": li_at, "domain": ".linkedin.com", "path": "/"}]
    if jsessionid:
        quoted = jsessionid if jsessionid.startswith('"') else f'"{jsessionid}"'
        cookies.append({"name": "JSESSIONID", "value": quoted,
                        "domain": ".linkedin.com", "path": "/"})
    return cookies


def _autoscroll(page, steps=6, pause_ms=600):
    """Scroll to bottom a few times to trigger lazy-loaded article cards."""
    for _ in range(steps):
        page.mouse.wheel(0, 20000)
        page.wait_for_timeout(pause_ms)


def _extract_dom(page):
    """Collect pulse-article links + titles from the rendered DOM."""
    js = """
    () => {
      const seen = new Set();
      const out = [];
      document.querySelectorAll('a[href*="/pulse/"]').forEach(a => {
        const url = (a.href || '').split('?')[0];
        const title = (a.innerText || a.textContent || '').trim();
        if (!url || !title || seen.has(url)) return;
        seen.add(url);
        out.push({ title, url, date: "", image: null, description: "" });
      });
      return out;
    }
    """
    return page.evaluate(js)
