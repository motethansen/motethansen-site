"""Profile-page discovery: URL extraction, slug identity, authorship guard.

All offline — the network side of discovery is a probabilistic rate-limited wall
(see linkedin_discover's module docstring) and is not something a test can assert
against without being flaky by construction.
"""
import pytest

import linkedin_discover as d
import linkedin_public as p
import linkedin_sync as s


# ── URL extraction ────────────────────────────────────

def test_extract_urls_dedupes_and_builds_full_urls():
    html = """
      <a href="/pulse/first-article-michael-hansen">x</a>
      <a href="https://www.linkedin.com/pulse/first-article-michael-hansen?trk=y">dupe</a>
      <a href="/pulse/second-article-michael-hansen">y</a>
    """
    assert d.extract_urls(html) == [
        "https://www.linkedin.com/pulse/first-article-michael-hansen",
        "https://www.linkedin.com/pulse/second-article-michael-hansen",
    ]


def test_extract_urls_is_case_insensitive_on_slug():
    assert d.extract_urls('<a href="/PULSE/Mixed-Case-Hansen">') == [
        "https://www.linkedin.com/pulse/mixed-case-hansen"]


def test_extract_urls_empty_when_no_articles():
    assert d.extract_urls("<html><body>nothing here</body></html>") == []


def test_wall_detection_only_scans_the_head_of_the_document():
    # A real profile page says "Sign in" in its footer — that must not read as a
    # wall, or every successful fetch would be discarded.
    html = "<html><head><title>Michael</title></head>" + ("x" * 8000) + "Sign in to view more"
    assert not d._WALL_RE.search(html[:d._WALL_SCAN_BYTES])


# ── slug identity ─────────────────────────────────────

def test_slug_identity_matches_across_url_variants():
    a = s._slug("https://www.linkedin.com/pulse/my-post-hansen")
    b = s._slug("https://www.linkedin.com/pulse/my-post-hansen/")
    c = s._slug("https://www.linkedin.com/pulse/my-post-hansen?trk=abc")
    assert a == b == c == "my-post-hansen"


def test_slug_empty_for_non_article_url():
    assert s._slug("https://www.linkedin.com/in/someone") == ""
    assert s._slug("") == ""
    assert s._slug(None) == ""


# ── authorship guard ──────────────────────────────────

def _art(url, author):
    return {"title": "t", "url": url, "author": author}


OWNER = {"author_match": "hansen"}


def test_guard_keeps_owner_authored_discovered_article():
    url = "https://www.linkedin.com/pulse/a-post-hansen"
    kept = s._keep_owner_articles([_art(url, "Michael Hansen, PhD")], {url}, OWNER)
    assert len(kept) == 1


def test_guard_drops_someone_elses_discovered_article():
    url = "https://www.linkedin.com/pulse/a-post-by-other"
    kept = s._keep_owner_articles([_art(url, "Jane Doe")], {url}, OWNER)
    assert kept == []


def test_guard_trusts_curated_urls_regardless_of_author():
    # Not in the discovered set => came from article-urls.txt => trusted.
    url = "https://www.linkedin.com/pulse/a-post-by-other"
    kept = s._keep_owner_articles([_art(url, "Jane Doe")], set(), OWNER)
    assert len(kept) == 1


def test_guard_falls_back_to_slug_when_author_missing():
    owned = "https://www.linkedin.com/pulse/a-post-michael-hansen"
    other = "https://www.linkedin.com/pulse/a-post-by-someone-else"
    kept = s._keep_owner_articles(
        [_art(owned, ""), _art(other, "")], {owned, other}, OWNER)
    assert [a["url"] for a in kept] == [owned]


def test_guard_is_a_noop_without_discovery():
    arts = [_art("https://www.linkedin.com/pulse/x", "Jane Doe")]
    assert s._keep_owner_articles(arts, set(), OWNER) == arts


# ── JSON-LD author extraction ─────────────────────────

def test_json_ld_author_reads_through_nested_object():
    # The real payload nests image/interactionStatistic before "name" — a naive
    # [^}]* pattern stops at the first '}' and finds nothing.
    html = ('{"author":{"@type":"Person",'
            '"image":"https://media.licdn.com/x.jpg",'
            '"interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":3428},'
            '"name":"Michael Hansen, PhD"}}')
    assert p._json_ld_author(html) == "Michael Hansen, PhD"


def test_json_ld_author_absent_returns_empty():
    assert p._json_ld_author('{"headline":"no author here"}') == ""
