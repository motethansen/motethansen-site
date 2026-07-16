"""
The Playwright engine must import without Chromium/playwright installed (the heavy
import is lazy, inside fetch_articles), and build cookies correctly.
"""
import linkedin_playwright as lp


def test_module_imports_without_playwright():
    assert callable(lp.fetch_articles)
    assert callable(lp._extract_dom)


def test_cookie_shapes():
    cookies = lp._cookies("abc", "ajax:123")
    li = {c["name"]: c for c in cookies}
    assert li["li_at"]["value"] == "abc"
    assert li["li_at"]["domain"] == ".linkedin.com"
    assert li["JSESSIONID"]["value"] == '"ajax:123"'   # quoted


def test_cookie_without_jsessionid():
    assert [c["name"] for c in lp._cookies("abc", "")] == ["li_at"]


def test_fetch_raises_importerror_when_playwright_absent():
    # When playwright isn't installed, the lazy import fails — which
    # linkedin_source.fetch_articles catches to report a clean message.
    import importlib.util
    if importlib.util.find_spec("playwright") is not None:
        import pytest
        pytest.skip("playwright is installed here; skipping absence check")
    import pytest
    with pytest.raises(ImportError):
        lp.fetch_articles("profile", "li_at")


def _browser_or_skip():
    """Return a launched headless Chromium, or skip if the browser isn't available."""
    import pytest
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pytest.skip("playwright not installed")
    pw = sync_playwright().start()
    try:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    except Exception as exc:  # noqa: BLE001 — no browser binary in this env
        pw.stop()
        pytest.skip(f"chromium not available: {exc}")
    return pw, browser


def test_dom_extraction_real_browser():
    """Exercise _extract_dom in a real browser (skips where Chromium is absent)."""
    pw, browser = _browser_or_skip()
    try:
        page = browser.new_page()
        page.set_content(
            '<a href="https://www.linkedin.com/pulse/a?trk=x">A</a>'
            '<a href="https://www.linkedin.com/pulse/b">B</a>'
            '<a href="https://www.linkedin.com/feed/update/1">skip</a>'
            '<a href="https://www.linkedin.com/pulse/a?trk=dup">A dup</a>'
        )
        arts = lp._extract_dom(page)
    finally:
        browser.close()
        pw.stop()
    assert [a["url"] for a in arts] == [
        "https://www.linkedin.com/pulse/a",
        "https://www.linkedin.com/pulse/b",
    ]
    assert all({"title", "url", "date", "image", "description"} <= set(a) for a in arts)
