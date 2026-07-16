"""Normalisation, date parsing, and merge logic — the stable core of the sync."""
import linkedin_sync as s


def test_normalise_date_epoch_ms():
    assert s.normalise_date(1783482362288) == "2026-07-08"


def test_normalise_date_iso_and_plain():
    assert s.normalise_date("2026-05-31") == "2026-05-31"
    assert s.normalise_date("2026-06-04T10:00:00Z") == "2026-06-04"
    assert s.normalise_date("") == ""
    assert s.normalise_date(None) == ""


def test_normalise_strips_query_and_fields():
    n = s.normalise({
        "title": "  Hi  ",
        "url": "https://x.com/pulse/a?trk=abc",
        "date": 1783482362288,
        "description": "  d  ",
    })
    assert n["url"] == "https://x.com/pulse/a"   # tracking params dropped
    assert n["title"] == "Hi"
    assert n["description"] == "d"
    assert n["date"] == "2026-07-08"


def test_normalise_requires_title_and_url():
    assert s.normalise({"title": "", "url": "u"}) is None
    assert s.normalise({"title": "t", "url": ""}) is None


def test_merge_union_override_sort_cap():
    existing = [{"title": "old", "url": "u1", "date": "2026-01-01", "description": "", "image": None}]
    scraped = [
        {"title": "NEW", "url": "u1", "date": "2026-02-01", "description": "", "image": None},
        {"title": "u2", "url": "u2", "date": "2026-03-01", "description": "", "image": None},
    ]
    m = s.merge(existing, scraped)
    assert [p["url"] for p in m] == ["u2", "u1"]     # newest-first
    assert m[1]["title"] == "NEW"                    # scraped overrode existing u1


def test_merge_preserves_history_on_partial_scrape():
    existing = [{"title": "kept", "url": "old", "date": "2025-01-01"}]
    scraped = [{"title": "fresh", "url": "new", "date": "2026-01-01"}]
    urls = {p["url"] for p in s.merge(existing, scraped)}
    assert urls == {"old", "new"}                    # nothing dropped


def test_merge_caps_length():
    many = [{"title": str(i), "url": f"u{i}", "date": f"2026-01-{i:02d}"} for i in range(1, 30)]
    assert len(s.merge([], many)) <= s.MAX_ARTICLES
