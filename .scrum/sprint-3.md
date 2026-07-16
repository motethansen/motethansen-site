# Sprint 3 — Writing Feed Reliability & Dynamic LinkedIn

**Dates:** 2026-07-16
**Agent:** Claude Opus 4.8 (Claude Code)
**Machine:** MacBook Pro (orchestrator)
**Status:** ✅ Deployed & live — 1 follow-up (droplet activation) carried to Sprint 4

---

## Goal
Fix the writing feed showing only LinkedIn (no Substack), make LinkedIn articles
load dynamically (no redeploy per article), and add an all-articles archive with
search. Root cause was a poisoned KV cache + an edge-fetch block on Substack.

---

## Tasks Completed

### Writing feed — cache poison guard + archive (PR #1)
- [x] `bd6e778` **Poison guard**: `functions/api/writing.js` + `workers/feed-refresh/worker.js`
  only cache a *healthy* build (≥1 Substack feed loaded). A Substack-less build is
  served but never persisted — a transient outage can no longer pin a LinkedIn-only
  feed. Worker write gets a 30h backstop TTL. Cache key `writing-feed-v3` → `v4`
  (now stores the FULL merged list).
- [x] `bd6e778` **Dynamic LinkedIn via KV**: both aggregators read KV key
  `linkedin-posts-v1`, falling back to the `content/linkedin-posts.js` seed.
- [x] `bd6e778` **Archive page** `/writing/` — all articles + client-side search;
  homepage shows top 9 with a "View all N articles" button when total > 9.
  `/api/writing?all=1` returns the full list; response includes `{ posts, total, cached }`.

### Substack edge-fetch fix (PR #5)
- [x] `01ad4cc` `fetchFeed` uses a **real browser User-Agent** and **drops
  `cf: { cacheEverything }`**. Substack was blocking the bot UA from Cloudflare
  egress, and cacheEverything pinned the block response at the edge → 0 Substack
  posts live. KV is now the only cache layer. **Verified live: 10 Substack + 3 LinkedIn.**

### LinkedIn sync job — scaffolding (PR #2, #4)
Python job in `linkedin-sync/` that scrapes LinkedIn articles → KV `linkedin-posts-v1`
so new articles appear with no redeploy. Runs on the DigitalOcean droplet (daily cron).
- [x] `b083a0d` Droplet deploy: `deploy/setup.sh` (venv/deps/cron), `deploy/run.sh`
  (cron entrypoint + logging), `deploy/systemd/` units.
- [x] `25e4086` **M1** — `notify.py` Resend failure alerts; `run()` core split from
  CLI; alert-on-failure wrapper; `--test-alert`; `--engine {auto,http,playwright}`; pytest harness.
- [x] `5cf1934` **M2** — `--capture` (save raw responses) + `--from-capture` (offline
  replay); split fetch from parse.
- [x] `ef5ab65` **M3b** — `linkedin_playwright.py` headless-Chromium fallback +
  adaptive HTTP→Playwright dispatch; `setup.sh --with-playwright`. Real-browser DOM
  test verified locally.
- [x] `1c5ea93` **M4** — README runbook (engine/capture/alerting + go-live steps).
- [x] `a95bf59` CLAUDE.md updated (poison guard, dynamic LinkedIn, Substack edge-fetch, scraper).
- **Tests:** 20 passed, 1 skipped.

---

## Deployments
Deployed via `bash deploy.sh` (Pages + Worker + KV cache-bust). Live site healthy:
Substack (Urban Life Works, Vizneo Academy) + LinkedIn both showing, cached.

PRs #1, #2, #4, #5, #6 all merged to `main`. (PR #3 was a stacked PR that merged
into the intermediate branch; its commits were re-landed via PR #4.)

---

## ⏭️ Next Steps (carried to Sprint 4 — LinkedIn scraper go-live)

The scraper code is complete, tested, and on `main`, but the KV key still holds only
the 3-article seed. Activation requires the operator (secrets + droplet SSH):

1. [ ] **Cloudflare API token** — create with **Workers KV Storage: Edit**; put in droplet `.env` (`CF_API_TOKEN`).
2. [ ] **LinkedIn `li_at` cookie** (+ `JSESSIONID`) from browser DevTools → droplet `.env`.
3. [ ] **Resend key + alert email** → droplet `.env` (`RESEND_API_KEY`, `ALERT_EMAIL`).
4. [ ] On droplet: `git pull` → `cd linkedin-sync` → `bash deploy/setup.sh`.
5. [ ] Verify alerting: `./.venv/bin/python linkedin_sync.py --test-alert` (expect email).
6. [ ] Seed + confirm KV path: `--from-file articles.sample.json` then `--print`.
7. [ ] **Decision point** — `--engine http --capture ./cap --dry-run`; inspect `./cap/`:
       real articles ⇒ keep `auto`; a login/999 wall ⇒ `bash deploy/setup.sh --with-playwright`
       then `--engine playwright --capture ./cap-pw --dry-run`. **Send the capture back to
       finalize the parser against real output.**
8. [ ] Go live: `bash deploy/run.sh` → confirm KV + live site update; cron then keeps it fresh.
9. [ ] Confirm alert-on-failure end-to-end (break the cookie once, expect email, restore).

### Contingency
- [ ] **Substack proxy fallback** — if Substack escalates from UA/edge-cache blocking
  to hard IP-blocking Cloudflare egress, route `fetchFeed` through a proxy. The poison
  guard keeps this failure graceful (feed degrades, never corrupts) until then.
