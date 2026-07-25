# Sprint 4 — LinkedIn Scraper Go-Live (Dockerised Droplet)

**Dates:** 2026-07-20 → **execution day: Friday 2026-07-24**
**Agent:** Claude Opus 4.8 (Claude Code)
**Machine:** MacBook Pro (orchestrator) + new DigitalOcean droplet (Docker host)
**Status:** 📋 Planned — blocked on droplet provisioning (operator)

---

## Goal
Milestone M1 — LinkedIn articles auto-sync to KV `linkedin-posts-v1` on a schedule and
appear on the live site, with failure alerting verified. Change from Sprint 3's plan:
the job runs as a **Docker container** on a fresh Docker-enabled droplet, not a venv +
host cron.

### Why Docker (change of approach)
- **Playwright without pain.** The fallback engine needs headless Chromium + ~15 system
  libs. `setup.sh --with-playwright` installs those into the host; a prebuilt Playwright
  image makes it a non-event and keeps the droplet clean.
- **Reproducible.** The image pins Python + Chromium + deps, so a droplet rebuild is
  `docker run`, not a re-run of provisioning that may drift.
- **Not DO Functions.** Serverless was reconsidered and rejected again: the DO Functions
  runtime cannot run Chromium and the dep size exceeds the function limit, so it only
  works if the HTTP engine clears LinkedIn's auth wall — still unverified. Docker keeps
  both engines available without betting on that.

---

## Current state (verified 2026-07-20)
- KV key `linkedin-posts-v1` **does not exist** — `key list` on namespace
  `1b97cac1e10d4bcaaa1bef301a86af26` returns only `writing-feed-v4`.
- The 3 LinkedIn posts on the live site are the `content/linkedin-posts.js` seed,
  served via the fallback path in `functions/api/writing.js`.
- Cloudflare Worker cron (`0 20 * * *`) **is healthy** — `writing-feed-v4` carries a
  fresh 30h backstop TTL. Substack posts are current. Nothing to fix there.
- The scraper has **never executed against real LinkedIn** on any host. The 20 passing
  tests run against fixtures/captures, not live output.

---

## Blocked on operator — droplet details needed

Please create the droplet and send back:

| Need | Notes |
|---|---|
| **Host + SSH** | IP / hostname, SSH user, key already authorised |
| **Size** | ≥ **2 GB RAM** (`s-2vcpu-2gb`). Chromium OOMs on the 1 GB plan; if 1 GB is all that's available, add 2 GB swap and say so |
| **Region** | Any. Note it — LinkedIn treats some ranges more harshly, relevant if we hit a wall |
| **OS** | Ubuntu 24.04 LTS + Docker Engine & compose plugin (`docker --version`, `docker compose version`) |
| **Secrets** | Confirm you have: CF API token (**Workers KV: Edit**), LinkedIn `li_at` (+ `JSESSIONID`), Resend key + alert email. Send via a secure channel, **not** this chat or the repo |

I can't provision or SSH from here — this is the hand-off point.

---

## Tasks

### A. Containerisation (agent — DONE 2026-07-25, on the Mac)
- [x] `linkedin-sync/Dockerfile` — base `mcr.microsoft.com/playwright/python:v1.47.0-noble`
      so both engines work from one image with no rebuild at the decision point.
      Non-root (`pwuser`); installs only `requirements.txt` (playwright + Chromium come
      from the base — not reinstalled, to avoid package/browser version drift);
      entrypoint `python linkedin_sync.py` so all existing flags pass through.
- [x] `linkedin-sync/compose.yaml` — `env_file: .env`, no restart policy (batch job,
      run via `compose run --rm`), `shm_size: 1gb` (Chromium), log driver capped.
- [x] `linkedin-sync/deploy/docker-run.sh` — scheduler entrypoint: `docker compose run
      --rm sync`, propagates the container exit code so a failure shows in systemd.
- [x] **Schedule stays opt-in** (keeps `3c77abf`'s intent): `deploy/enable-schedule.sh`
      / `deploy/disable-schedule.sh` install/remove a systemd timer at **05:30 UTC**
      (`deploy/systemd/linkedin-sync-docker.{service,timer}`; enable writes a path
      drop-in). Timer over cron — `journalctl` logging, no double-run risk.
- [x] `.dockerignore` (excludes `.env`, `.venv`, `__pycache__`, captures, `.git`).
- [x] Local image build + smoke-test on the Mac (2026-07-25): image builds;
      entrypoint + `--help` work; Chromium launches (129.0.6668.29 / PW 1.47);
      HTTP path reaches the scrape and fails cleanly on the missing cookie (no
      crash, no secret leak). **Fix found & applied:** the Playwright base ships
      browsers but NOT the pip package — Dockerfile now installs `playwright==1.47.0`
      pinned to the base's Chromium build.
- [x] README: Docker deploy section added; venv+cron path marked legacy.

### 🔑 Decision-point OUTCOME (2026-07-25) — architecture pivot
Empirically tested from the droplet (datacentre IP, valid cookie):
- Article **listing** `/in/<profile>/recent-activity/articles/` → **HTTP 999 authwall**
  (IP-reputation anti-bot; not a parser bug — chasing endpoints won't beat it).
- Voyager REST `identity/profile/...` → **404** (stale path).
- `/today/author/<profile>` → 200 authenticated but WRONG feature (news author, no Pulse articles).
- Headless Chromium → **login wall** (fingerprinted). So HTTP is the *better* path here, not Playwright.
- **Individual published article page (public, no cookie)** → **200 + full OG/JSON-LD metadata.** ✅

**Pivot (operator-approved):** stop scraping the walled listing. Fetch each article's
PUBLIC page by URL and read OG/JSON-LD. Reliable, cookie-free, no evasion. New-article
discovery is one manual URL paste (`--add-url`); everything downstream stays automatic.
- `linkedin_public.py` — public metadata fetcher (fixed an apostrophe-truncation regex bug).
- `linkedin_sync.py` — `--url` / `--add-url` / `--urls-file`; default run reads `article-urls.txt`.
- `article-urls.txt` — durable URL list (seeded with the 3 known articles).
- Tests: 25 passed, 2 skipped (added `tests/test_public.py`).
- Legacy cookie scraper retained but demoted; the Playwright path is walled from this IP.

### B. Go-live on the droplet — DONE 2026-07-25
- [x] Droplet: Ubuntu 24.04, Docker 29.6.2, compose v5.3.1. Added 2 GB swap (was 0).
      Code synced via rsync (secrets excluded); `.env` created chmod 600 + filled by operator.
- [x] `docker compose build` on the droplet (image 3.12 GB). Shares host with
      `budgetapp-api` + `edge-traefik-1` — all our resources namespaced, neighbours untouched.
- [x] Alerting verified: `--test-alert` → email delivered (also fixed CF token: it lacked
      Workers KV:Edit — token verify OK but KV list 401 until permission added).
- [x] KV write path confirmed: seeded via `--from-file`, then the URL-driven path;
      `linkedin-posts-v1` now holds real metadata (full titles, dates, images).
- [x] 🔑 Decision point resolved → **pivot to public URL fetch** (see above).
- [x] Go live: real run writes KV; `--print` shows 3 full articles.
- [x] Timer enabled: `linkedin-sync-docker.timer`, next 05:30 UTC. Manual
      `systemctl start` of the service → `Result=success`, exit 0 (full chain proven).
- [ ] Alert-on-failure for real: break `LINKEDIN_LI_AT`, run, expect email, restore.
      (Cookie no longer on the critical path for fetching — but still worth a one-time check.)
- [x] **Added the newest article** ("From a QR code to a full teaching platform…",
      2026-07-18) via `--add-url`. KV now holds 4 LinkedIn articles; live site shows it
      at the top. Fixed a 2nd bind-mount bug: `article-urls.txt` must be a host-mounted
      writable file (uid 1001), not baked into the image, or `--add-url` can't persist.
- [ ] Commit the Sprint-4 work to a branch / PR (nothing committed yet; droplet runs off rsync'd tree).

### ⚠️ Incident (2026-07-25): cache-bust exposed a Substack datacentre-egress block
Busting `writing-feed-v4` to surface the new article forced a midday Pages rebuild that
returned **0 Substack** (only LinkedIn) — the poison guard then (correctly) refused to
cache it, so it couldn't self-heal, and the site briefly showed a LinkedIn-only feed.
Root cause: **Substack now 403s datacentre egress** — verified the droplet (DigitalOcean)
gets HTTP 403 on both feeds while a residential IP (Mac) gets 200. The Cloudflare Pages
Function's egress was also failing at that moment (it had succeeded ~5 days prior, so the
block is intermittent/escalating, not constant).
- **Restore:** ran the REAL `writing.js` builder in Node on the Mac (residential IP, so
  Substack fetch works), fed it the live LinkedIn KV array, captured the exact healthy
  merged list (10 Substack + 4 LinkedIn), and wrote it to `writing-feed-v4` with a **24h
  TTL** to bridge past tonight's 20:00 UTC refresh Worker. Live site: `cached:true`, 14 posts.
- **Follow-up probe (same day):** controlled test — deleted the cache, forced two fresh
  Cloudflare-egress rebuilds, restored. Result: **Substack=10 on a fresh `cached:false`
  rebuild** — i.e. **Cloudflare egress works**; the midday 0-Substack was a transient blip,
  not a persistent block. The hard 403 is confirmed only for DigitalOcean (the droplet).
  The site self-heals (a healthy rebuild caches itself); the 20:00 UTC Worker should refresh
  fine. **Substack proxy fallback: shelved** unless degradation actually recurs.
- **Lesson:** don't bust `writing-feed-v4` unless a healthy rebuild is confirmed reachable;
  prefer writing a pre-built healthy feed (as done here) over deleting and hoping.

---

## Definition of done
`linkedin-posts-v1` holds real scraped articles (count > 3), the site shows the new
article without a redeploy, the systemd timer is enabled and its next run confirmed
(`systemctl list-timers`), and a deliberately-broken run sends an alert email.

---

## Risks
- **The decision point is a genuine unknown.** LinkedIn may serve a login wall or a 999
  to datacentre IPs on both engines. If Playwright is also walled, fallbacks are: run the
  scrape from a residential IP on a schedule, or keep LinkedIn manual (edit
  `content/linkedin-posts.js` per article) and close M1 as "not achievable as designed".
  Decide on the day rather than sinking the sprint into evasion work.
- **Cookie expiry is the ongoing failure mode.** `li_at` lasts ~1 year but dies on
  password change/logout. The alert email is the detection mechanism — hence step B's
  final task is not optional.
- **Sizing.** Chromium on a 1 GB droplet OOM-kills mid-run and looks like a parser bug.

---

## Not in scope
Substack proxy fallback (contingency only), analytics, OG images — see `backlog.md`.

## Stopgap available now
The new article can be added to `content/linkedin-posts.js` and deployed today, so the
site is correct regardless of when the automation lands. Needs the article URL.
