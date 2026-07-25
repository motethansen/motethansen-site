"""Public-page metadata extraction (linkedin_public) — the OG/JSON-LD parser."""
import linkedin_public as lp


ARTICLE_HTML = '''
<html><head>
<meta property="og:title" content="The Smart City Trap: Why We're Measuring the Wrong Things (And How to Fix It)" />
<meta property="og:url" content="https://www.linkedin.com/pulse/smart-city-trap-abc" />
<meta property="og:image" content="https://media.licdn.com/dms/image/v2/xyz.png" />
<meta property="og:description" content="It's a look at what we get wrong, and why." />
<script type="application/ld+json">{"datePublished":"2026-07-08T04:06:56.000+00:00"}</script>
</head><body>...</body></html>
'''


def test_meta_keeps_apostrophe_in_double_quoted_value():
    # Regression: a naive [^"']* class truncates "Why We're …" at the apostrophe.
    assert lp._meta(ARTICLE_HTML, "og:title") == \
        "The Smart City Trap: Why We're Measuring the Wrong Things (And How to Fix It)"


def test_meta_handles_reversed_attr_order():
    html = '<meta content="Hello" property="og:title">'
    assert lp._meta(html, "og:title") == "Hello"


def test_meta_missing_returns_empty():
    assert lp._meta("<html></html>", "og:title") == ""


def test_json_ld_date():
    assert lp._json_ld_date(ARTICLE_HTML) == "2026-07-08T04:06:56.000+00:00"


def test_fetch_article_parses_all_fields(monkeypatch):
    class FakeResp:
        status_code = 200
        text = ARTICLE_HTML

    monkeypatch.setattr(lp.requests, "get", lambda *a, **k: FakeResp())
    art = lp.fetch_article("https://www.linkedin.com/pulse/smart-city-trap-abc")
    assert art["title"].startswith("The Smart City Trap")
    assert art["url"] == "https://www.linkedin.com/pulse/smart-city-trap-abc"
    assert art["image"].endswith("xyz.png")
    assert art["date"] == "2026-07-08T04:06:56.000+00:00"
    assert "get wrong" in art["description"]


def test_fetch_article_raises_on_non_200(monkeypatch):
    class FakeResp:
        status_code = 999
        text = "<html>authwall</html>"

    monkeypatch.setattr(lp.requests, "get", lambda *a, **k: FakeResp())
    try:
        lp.fetch_article("https://www.linkedin.com/in/x/recent-activity/articles/")
        assert False, "expected PublicFetchError"
    except lp.PublicFetchError:
        pass
