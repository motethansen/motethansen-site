"""The sync leaves a status record for the site's /api/health; it must never break the run."""
import json

import linkedin_sync as ls

CFG = {"account_id": "a", "namespace_id": "n", "api_token": "t"}


class _Resp:
    def raise_for_status(self):
        pass


def test_status_record_reports_discovery_and_counts(monkeypatch):
    seen = {}

    def fake_put(url, headers=None, data=None, params=None, timeout=None):
        seen.update(url=url, body=json.loads(data), params=params)
        return _Resp()

    monkeypatch.setattr(ls.requests, "put", fake_put)
    ls._DISCOVERY["state"] = "walled"
    ls.kv_write_status(CFG, existing=[{"url": "a"}] * 10, scraped=[{"url": "a"}] * 9, merged=[{"url": "a"}] * 10)
    assert seen["url"].endswith("/values/linkedin-sync-status-v1")
    assert seen["body"]["discovery"] == "walled"
    assert (seen["body"]["collected"], seen["body"]["total"], seen["body"]["new"]) == (9, 10, 0)
    assert seen["body"]["ts"] > 1_700_000_000


def test_status_write_failure_never_raises(monkeypatch, capsys):
    def boom(*a, **k):
        raise RuntimeError("cloudflare down")

    monkeypatch.setattr(ls.requests, "put", boom)
    ls.kv_write_status(CFG, [], [], [])          # must not raise
    assert "status record not written" in capsys.readouterr().out


def test_run_that_skipped_discovery_leaves_the_record_alone(monkeypatch):
    called = []
    monkeypatch.setattr(ls.requests, "put", lambda *a, **k: called.append(1) or _Resp())
    ls._DISCOVERY["state"] = "skipped"
    ls.kv_write_status(CFG, [], [], [])
    assert called == []
