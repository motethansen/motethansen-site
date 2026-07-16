"""
Parser helpers in linkedin_source. These cover the pure extraction logic today;
Milestone 3 adds full-response fixtures (captured from real LinkedIn output) that
exercise _fetch_via_html / the Playwright parse end-to-end.
"""
import linkedin_source as ls


def test_iter_ldjson_handles_graph_list_and_object():
    obj = {"@type": "BlogPosting", "headline": "A"}
    graph = {"@graph": [{"@type": "Article", "headline": "B"}]}
    lst = [obj, graph]
    types = [n.get("@type") for n in ls._iter_ldjson(lst)]
    assert types == ["BlogPosting", "Article"]


def test_ldjson_image_shapes():
    assert ls._ldjson_image({"image": "https://x/i.png"}) == "https://x/i.png"
    assert ls._ldjson_image({"image": {"url": "https://x/o.png"}}) == "https://x/o.png"
    assert ls._ldjson_image({"image": [{"url": "https://x/a.png"}]}) == "https://x/a.png"
    assert ls._ldjson_image({}) is None


def test_article_from_voyager_keeps_only_pulse():
    art = ls._article_from_voyager({
        "permalink": "https://www.linkedin.com/pulse/foo-bar",
        "title": "Foo Bar",
        "publishedAt": 1783482362288,
        "subtitle": "sub",
    })
    assert art["url"].endswith("/pulse/foo-bar")
    assert art["title"] == "Foo Bar"
    # non-article activity (no /pulse/) is dropped
    assert ls._article_from_voyager({"permalink": "https://www.linkedin.com/feed/update/x"}) is None
    assert ls._article_from_voyager("not a dict") is None


def test_engine_http_only_raises_without_cookie():
    import pytest
    with pytest.raises(ls.LinkedInFetchError):
        ls.fetch_articles(profile="x", li_at="", engine="http")


def test_parse_html_extracts_ldjson():
    html = """
    <html><head>
    <script type="application/ld+json">
    {"@graph":[{"@type":"BlogPosting","headline":"My Post",
      "url":"https://www.linkedin.com/pulse/my-post",
      "datePublished":"2026-07-01","description":"desc",
      "image":{"url":"https://x/cover.png"}}]}
    </script></head><body></body></html>
    """
    arts = ls._parse_html(html)
    assert len(arts) == 1
    assert arts[0]["url"].endswith("/pulse/my-post")
    assert arts[0]["image"] == "https://x/cover.png"


def test_fetch_from_capture_round_trip(tmp_path):
    # simulate a captured dir: a walled voyager.json + a good author.html
    (tmp_path / "voyager.json").write_text("<html>login wall</html>")  # non-JSON, ignored
    (tmp_path / "author.html").write_text(
        '<script type="application/ld+json">'
        '{"@type":"Article","headline":"Captured",'
        '"url":"https://www.linkedin.com/pulse/captured","datePublished":"2026-06-01"}'
        '</script>'
    )
    arts = ls.fetch_from_capture(str(tmp_path))
    assert [a["url"] for a in arts] == ["https://www.linkedin.com/pulse/captured"]
