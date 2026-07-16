"""notify.send_failure — no-op without config, best-effort with it, never raises."""
import notify


def test_skips_without_config(monkeypatch, capsys):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("ALERT_EMAIL", raising=False)
    assert notify.send_failure("s", "b") is False
    assert "skipping alert" in capsys.readouterr().out


def test_posts_when_configured(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setenv("ALERT_EMAIL", "me@example.com")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "noreply@vizneo.com")

    sent = {}

    class Resp:
        def raise_for_status(self):
            pass

    def fake_post(url, headers=None, json=None, timeout=None):
        sent.update(url=url, headers=headers, json=json)
        return Resp()

    monkeypatch.setattr(notify.requests, "post", fake_post)

    assert notify.send_failure("boom", "details") is True
    assert sent["url"] == notify.RESEND_ENDPOINT
    assert sent["headers"]["Authorization"] == "Bearer re_test"
    assert sent["json"]["to"] == ["me@example.com"]
    assert "noreply@vizneo.com" in sent["json"]["from"]
    assert sent["json"]["subject"] == "[linkedin-sync] boom"


def test_never_raises_on_http_error(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setenv("ALERT_EMAIL", "me@example.com")

    def boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(notify.requests, "post", boom)
    assert notify.send_failure("s", "b") is False   # swallowed, returns False
