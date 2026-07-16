"""
notify.py — send a failure alert email via Resend.

Used by linkedin_sync.py to tell you when a scheduled run fails or scrapes 0
articles (almost always an expired li_at cookie). Same Resend sender the site's
contact form uses (functions/api/contact.js).

Config (env, all optional — if RESEND_API_KEY is unset this no-ops with a warning
so a missing alert channel never masks the original error):
    RESEND_API_KEY      Resend transactional key
    RESEND_FROM_EMAIL   verified sender, e.g. noreply@vizneo.com
    ALERT_EMAIL         where alerts go, e.g. hansenmichaelmotet@gmail.com
"""

import os

import requests

RESEND_ENDPOINT = "https://api.resend.com/emails"


def send_failure(subject, body):
    """
    Best-effort alert email. Returns True if sent, False if skipped/failed.
    Never raises — alerting must not crash the job or hide the real error.
    """
    api_key = os.environ.get("RESEND_API_KEY", "")
    sender = os.environ.get("RESEND_FROM_EMAIL", "noreply@vizneo.com")
    to = os.environ.get("ALERT_EMAIL", "")

    if not api_key or not to:
        print("notify: RESEND_API_KEY / ALERT_EMAIL not set — skipping alert email")
        return False

    try:
        resp = requests.post(
            RESEND_ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": f"motethansen-site <{sender}>",
                "to": [to],
                "subject": f"[linkedin-sync] {subject}",
                "text": body,
            },
            timeout=30,
        )
        resp.raise_for_status()
        print(f"notify: alert email sent to {to}")
        return True
    except Exception as exc:  # noqa: BLE001 — alerting is best-effort
        print(f"notify: failed to send alert email: {exc}")
        return False
