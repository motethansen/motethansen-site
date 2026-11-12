"""admin_poll: queued addresses become published (or a reported failure), one attempt each."""
import admin_poll as ap


class FakeKV:
    def __init__(self, store):
        self.store = dict(store)

    def list_keys(self, prefix):
        return [k for k in self.store if k.startswith(prefix)]

    def get_json(self, key):
        return self.store.get(key)

    def put_json(self, key, value, ttl=None):
        self.store[key] = value

    def delete(self, key):
        self.store.pop(key, None)


GOOD = "https://www.linkedin.com/pulse/new-article-michael-hansen-ab1"


def make(pending, posts=()):
    store = {"linkedin-posts-v1": list(posts)}
    for jid, url in pending.items():
        store["linkedin-pending:" + jid] = {"url": url}
        store["linkedin-add-status:" + jid] = {"state": "queued", "url": url}
    return FakeKV(store)


def test_nothing_queued_does_nothing():
    kv = make({})
    ran = []
    assert ap.process(kv, "/nonexistent", run=lambda: ran.append(1)) == 0
    assert ran == []


def test_queued_article_is_appended_synced_confirmed_and_cleaned_up(tmp_path):
    urls = tmp_path / "article-urls.txt"
    urls.write_text("https://www.linkedin.com/pulse/old-one-xyz\n")
    kv = make({"j1": GOOD + "/"})

    def run():                                                 # the sync would have merged it into KV
        kv.store["linkedin-posts-v1"].append({"url": GOOD, "title": "New article"})
        return 0, ""

    assert ap.process(kv, str(urls), run=run, listed=lambda u: True) == 1
    assert GOOD in urls.read_text().splitlines()
    rec = kv.store["linkedin-add-status:j1"]
    assert (rec["state"], rec["title"]) == ("published", "New article")
    assert "reason" not in rec
    assert "linkedin-pending:j1" not in kv.store


def test_published_but_not_yet_on_site_says_so(tmp_path):
    kv = make({"j1": GOOD})
    kv.store["linkedin-posts-v1"].append({"url": GOOD, "title": "T"})
    ap.process(kv, str(tmp_path / "u.txt"), run=lambda: (0, ""), listed=lambda u: False)
    rec = kv.store["linkedin-add-status:j1"]
    assert rec["state"] == "published" and "top of the hour" in rec["reason"]


def test_article_missing_after_sync_is_a_reported_failure_not_a_retry_loop(tmp_path):
    kv = make({"j1": GOOD})
    ap.process(kv, str(tmp_path / "u.txt"), run=lambda: (0, ""), listed=lambda u: True)
    assert kv.store["linkedin-add-status:j1"]["state"] == "failed"
    assert "linkedin-pending:j1" not in kv.store               # one attempt only


def test_sync_failure_reason_reaches_the_page(tmp_path):
    kv = make({"j1": GOOD})
    ap.process(kv, str(tmp_path / "u.txt"), run=lambda: (1, "boom: CF token expired"), listed=lambda u: True)
    rec = kv.store["linkedin-add-status:j1"]
    assert rec["state"] == "failed" and "exit 1" in rec["reason"] and "CF token expired" in rec["reason"]


def test_non_linkedin_address_never_reaches_the_sync(tmp_path):
    kv = make({"j1": "https://evil.example/pulse/x-y-z", "j2": "https://www.linkedin.com/in/someone"})
    ran = []
    ap.process(kv, str(tmp_path / "u.txt"), run=lambda: ran.append(1) or (0, ""))
    assert ran == []
    assert {kv.store["linkedin-add-status:j1"]["state"], kv.store["linkedin-add-status:j2"]["state"]} == {"failed"}
    assert not any(k.startswith("linkedin-pending:") for k in kv.store)


def test_two_submissions_one_sync(tmp_path):
    other = "https://www.linkedin.com/pulse/second-article-michael-hansen-cd2"
    kv = make({"a": GOOD, "b": other})
    runs = []

    def run():
        runs.append(1)
        kv.store["linkedin-posts-v1"] += [{"url": GOOD, "title": "A"}, {"url": other, "title": "B"}]
        return 0, ""

    ap.process(kv, str(tmp_path / "u.txt"), run=run, listed=lambda u: True)
    assert len(runs) == 1
    assert kv.store["linkedin-add-status:a"]["state"] == kv.store["linkedin-add-status:b"]["state"] == "published"


def test_site_lists_matches_by_slug_and_gives_up():
    assert ap.site_lists(GOOD, wait_s=1, fetch=lambda: [{"url": GOOD + "/"}])
    assert not ap.site_lists(GOOD, wait_s=0, fetch=lambda: [])


def test_failed_address_is_taken_back_out_of_the_list(tmp_path):
    urls = tmp_path / "article-urls.txt"
    urls.write_text("https://www.linkedin.com/pulse/keep-me-abc\n")
    kv = make({"j1": GOOD})
    ap.process(kv, str(urls), run=lambda: (0, ""), listed=lambda u: True)       # not in KV -> failed
    assert kv.store["linkedin-add-status:j1"]["state"] == "failed"
    assert urls.read_text() == "https://www.linkedin.com/pulse/keep-me-abc\n"   # typo removed, old entry kept


def test_heartbeat_is_written_at_most_every_ten_minutes(tmp_path):
    kv = FakeKV({})
    hb = str(tmp_path / "hb")
    assert ap.heartbeat(kv, hb, now=lambda: 1_000_000) is True
    assert kv.store["linkedin-poll-status-v1"] == {"ts": 1_000_000}
    kv.store.pop("linkedin-poll-status-v1")
    assert ap.heartbeat(kv, hb, now=lambda: 1_000_000) is False        # same instant: throttled by the local file
    assert "linkedin-poll-status-v1" not in kv.store
    import os
    os.utime(hb, (900_000, 900_000))                                  # file is now 100 000 s old
    assert ap.heartbeat(kv, hb, now=lambda: 1_000_000) is True
