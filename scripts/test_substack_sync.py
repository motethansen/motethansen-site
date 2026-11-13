import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import substack_sync as ss

RSS = """<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title><![CDATA[From one prompt to a Scrum team]]></title><description><![CDATA[Building distributed-infra]]></description>
<link>https://vizneoacademy.substack.com/p/from-one-prompt-to-a-scrum-team</link><pubDate>Thu, 12 Nov 2026 04:36:19 GMT</pubDate>
<enclosure url="https://substackcdn.com/image/fetch/cover.png" length="0" type="image/jpeg"/><content:encoded><![CDATA[<p>Body</p><img src="https://substackcdn.com/inline.png">]]></content:encoded></item>
<item><title>No subtitle &amp; an entity</title><description></description><link>https://vizneoacademy.substack.com/p/b</link><pubDate>Mon, 02 Mar 2026 10:00:00 +0800</pubDate>
<content:encoded><![CDATA[<p>First <b>words</b> of the post body that become the description.</p><img src="https://substackcdn.com/inline2.png">]]></content:encoded></item>
<item><title>Bad date</title><link>https://vizneoacademy.substack.com/p/c</link><pubDate>garbage</pubDate></item>
<item><title></title><link>https://vizneoacademy.substack.com/p/no-title</link></item>
<item><title>No link</title></item>
</channel></rss>"""


def test_parse_feed_extracts_fields_and_skips_unusable_items():
    items = ss.parse_feed(RSS)
    assert [i["title"] for i in items] == ["From one prompt to a Scrum team", "No subtitle & an entity", "Bad date"]
    a = items[0]
    assert a["url"] == "https://vizneoacademy.substack.com/p/from-one-prompt-to-a-scrum-team"
    assert a["date"] == "2026-11-12T04:36:19Z" and a["description"] == "Building distributed-infra"
    assert a["image"] == "https://substackcdn.com/image/fetch/cover.png"          # enclosure wins over inline images


def test_description_and_image_fall_back_to_the_body_and_dates_are_utc():
    b = ss.parse_feed(RSS)[1]
    assert b["description"].startswith("First words of the post body")
    assert b["image"] == "https://substackcdn.com/inline2.png"
    assert b["date"] == "2026-03-02T02:00:00Z"                                     # +0800 converted to UTC


def test_unparseable_date_becomes_none_instead_of_failing_the_item():
    assert ss.parse_feed(RSS)[2]["date"] is None


def test_push_sends_bearer_token_and_the_source_name(monkeypatch):
    seen = {}

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"ok": True, "inserted": 1, "updated": 0, "skipped": []}).encode()

    def fake_urlopen(req, timeout=None):
        seen["auth"] = req.get_header("Authorization"); seen["body"] = json.loads(req.data); seen["url"] = req.full_url
        return R()

    monkeypatch.setattr(ss.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(ss.json, "load", lambda r: json.loads(r.read()))
    res = ss.push("va-substack", [{"url": "u", "title": "t"}], "TOKEN123", endpoint="https://example.test/x")
    assert res["inserted"] == 1 and seen["auth"] == "Bearer TOKEN123"
    assert seen["body"]["source"] == "va-substack" and seen["body"]["entries"][0]["title"] == "t"


def test_main_pushes_each_publication_and_reports_failure_without_stopping(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(ss, "load_token", lambda: "T")
    monkeypatch.setattr(ss, "fetch", lambda url, timeout=30: RSS)
    monkeypatch.setattr(ss, "with_retry", lambda fn, **k: fn())

    def fake_push(source, entries, token, **k):
        calls.append(source)
        if source == "va-substack":
            raise OSError("network down")
        return {"inserted": 2, "updated": 1, "skipped": []}

    monkeypatch.setattr(ss, "push", fake_push)
    assert ss.main([]) == 1                                  # one publication failed ...
    assert calls == ["va-substack", "ulw-substack"]          # ... but the other was still pushed
    assert "va-substack: FAILED" in capsys.readouterr().err


def test_dry_run_needs_no_token_and_pushes_nothing(monkeypatch, capsys):
    monkeypatch.setattr(ss, "load_token", lambda: (_ for _ in ()).throw(AssertionError("token must not be read")))
    monkeypatch.setattr(ss, "fetch", lambda url, timeout=30: RSS)
    monkeypatch.setattr(ss, "push", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not push")))
    assert ss.main(["--dry-run"]) == 0
    assert "va-substack: 3 item(s)" in capsys.readouterr().out
