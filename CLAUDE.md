# motethansen-site — Claude Context

## What this repo is
Personal website for **Michael Motet Hansen** (motethansen.com) and resume subdomain
(michael.motethansen.com). Hosted on **Cloudflare Pages** — static files in `public/`,
serverless logic in `functions/api/`, and a standalone scheduled Worker in
`workers/feed-refresh/`. A separate Python job (`linkedin-sync/`) runs on
DigitalOcean to keep LinkedIn articles fresh.

## Repo structure
```
public/
  index.html          — main landing page (motethansen.com); shows top 9 posts + "View all" button
  style.css           — shared dark theme stylesheet
  favicon.svg         — SVG favicon (mh monogram, purple-to-teal gradient)
  resume/
    index.html        — resume page (michael.motethansen.com), standalone CSS
  writing/
    index.html        — full articles archive with client-side search (fetches /api/writing?all=1)

content/
  linkedin-posts.js   — SEED/fallback array of LinkedIn articles (used when KV key is empty)

functions/
  _middleware.js      — host-based routing: michael.motethansen.com → /resume/ (ASSETS rewrite)
  api/
    contact.js        — contact form handler → Resend API → hansenmichaelmotet@gmail.com
    writing.js        — thin HTTP layer over shared/feed-core.js. Serves writing-feed-v4 from KV, else rebuilds.
                        ?all=1 returns full list; default returns top 9. Response includes { posts, total, cached }.
                        ?debug=1 forces a live rebuild and returns per-source status (never writes the merged cache).
    publications.js   — (legacy stub, ORCID now fetched client-side in JS)

shared/
  feed-core.js        — SINGLE source of truth for feed fetch/parse/merge/cache, imported by BOTH the Pages
                        Function and the cron Worker. Holds SOURCES, the RSS parser, per-source fallback,
                        and the cache-write guard. Do not fork this logic back into the entry points.

workers/
  feed-refresh/
    worker.js         — scheduled cron Worker (HOURLY, 0 * * * * UTC); thin wrapper over shared/feed-core.js.
                        GET /refresh?secret=…[&verbose=1] for a manual rebuild + per-source report.
                        Fails closed — REFRESH_SECRET is a Worker secret; the value is in .env
                        as FEED_REFRESH_SECRET.
    wrangler.toml     — Worker config, KV binding SITE_KV

scripts/
  warm-feed-cache.mjs — MANUAL BREAK-GLASS ONLY, never automated. Refreshes the per-source snapshots
                        from a residential IP. Needed only if a source is stuck on `snapshot` for days
                        and the 14-day TTL is near expiry. Substack: 200 to residential, 403 to the
                        droplets, intermittent to Cloudflare — so no server we own can do this.
  test-feed-fallback.mjs — simulates a blocked publication (network failure, 200 challenge page, no
                        snapshot) and asserts the fallback + cache-write guard hold. Needs network.

linkedin-sync/        — Python job on the WD-Ubuntu droplet (188.166.215.225), systemd timer 05:30 + 17:30 UTC.
                        Discovers new articles → fetches public metadata → merges → KV key linkedin-posts-v1
  linkedin_sync.py    — CLI + run() core: collect → normalise → merge (union by URL) → write KV.
                        Flags: --engine {auto,http,playwright}, --no-discover, --url/--add-url/--urls-file,
                        --capture/--from-capture, --from-file, --dry-run, --print, --test-alert
  linkedin_discover.py— finds NEW articles on the PUBLIC profile page (no cookie). Rate-limited per IP:
                        retries 4x with spaced jittered backoff, best-effort, never fatal.
  linkedin_public.py  — public per-article metadata (OG + JSON-LD), incl. the author name used by the
                        authorship guard. No cookie.
  linkedin_source.py  — legacy cookie scrape. Demoted/dead: LinkedIn walls the listing from datacentre IPs.
  linkedin_playwright.py — headless Chromium engine (lazy import); walled from these IPs, retained only.
  notify.py           — best-effort Resend failure-alert email (reuses site's Resend sender)
  article-urls.txt    — durable URL list. LIVE DATA: discovery appends to it, so the droplet's copy is
                        routinely AHEAD of git. sync-from-git.sh unions it, never replaces it.
  articles.sample.json— starter data for --from-file
  Dockerfile / compose.yaml — container image (Playwright python base) + run config
  deploy/             — setup.sh, run.sh, systemd/ units, enable-schedule.sh / disable-schedule.sh
                        sync-from-git.sh — bring a droplet's checkout to origin/main + rebuild.
                        Preserves .env and UNIONS article-urls.txt.
                        --dry-run to preview, --no-build to skip the image rebuild.
  tests/              — pytest: transform, notify, parsers, discovery/authorship guard, capture round-trip,
                        real-browser DOM (auto-skips). 38 passing, 2 skipped.
  README.md           — droplet deploy + adaptive-engine/capture/alerting workflow

wrangler.toml         — Pages project config, KV binding SITE_KV
deploy.sh             — manual deploy: pages deploy + worker deploy → rebuild via Worker /refresh → verify (fails loud if incomplete)
.env                  — GITIGNORED master key file (all API keys)
.scrum/               — sprint records and backlog
```

## Deploy
```bash
bash deploy.sh
```
Deploys the Pages site and the feed-refresh Worker, then asks the Worker to
rebuild the feed **on Cloudflare** (`/refresh`), and verifies the live result —
exiting non-zero if any publication is missing.

Nothing about the production data path runs on a dev machine: the rebuild, the
Substack fetches and the snapshot writes all happen in Cloudflare. Earlier versions
fetched the feeds locally and busted the KV key from here; that made a laptop part
of production and is gone.
**No GitHub auto-deploy** — always deploy manually from a dev machine.

### Droplets
| Host | IP | Role |
|---|---|---|
| **WD-Ubuntu** | 188.166.215.225 | **runs `linkedin-sync`** (timer 05:30 + 17:30 UTC) |
| Vizneo-docker | 206.189.153.183 | budgetapp-api, edge-traefik. Sync **retired** here 2026-07-30 (checkout kept as a fallback) |

The service moved because the Vizneo IP had been heavily rate limited by LinkedIn;
WD-Ubuntu answered 6/6 clean. Both are real git checkouts at `/opt/motethansen-site`
tracking `origin/main` over **HTTPS** (the repo is public and neither droplet has a
GitHub key — the old SSH remote failed with `Host key verification failed`).

Update the active host with:
```bash
ssh root@188.166.215.225 'cd /opt/motethansen-site && bash linkedin-sync/deploy/sync-from-git.sh'
```
Only ONE host may have the timer enabled, or KV gets written twice a day from two
places. Check with `systemctl is-enabled linkedin-sync-docker.timer` on both;
`deploy/disable-schedule.sh` turns it off.

The droplet previously ran hand-copied files while its checkout sat pinned at an old
commit — the code running was not the code in git and nothing surfaced that. Don't edit
code on a droplet; commit, then sync.

**Dev machines (MacBook Pro, Mac mini, ThinkPad) are for development only.** Never
schedule production work on them; use a droplet or a Cloudflare cron Worker.

## Environment variables (set in Cloudflare Pages dashboard)
| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend transactional email |
| `RESEND_FROM_EMAIL` | Sender address (noreply@vizneo.com) |
| `SITE_KV` | KV namespace binding (writing feed cache + LinkedIn posts) |

Local `.env` keys use `VIZNEO_CF_*` prefix to avoid wrangler auto-pickup, and hold
`FEED_REFRESH_SECRET` (the Worker's `/refresh` secret).
The `linkedin-sync/` job has its own `.env` on the active droplet (0600, gitignored;
see `linkedin-sync/.env.example`) with `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`,
`CF_API_TOKEN`, the `LINKEDIN_*` vars, and `FEED_REFRESH_URL`/`FEED_REFRESH_SECRET`.

## KV keys (namespace SITE_KV, id 1b97cac1e10d4bcaaa1bef301a86af26)
| Key | Written by | TTL |
|---|---|---|
| `writing-feed-v4` | cron Worker + Pages Function | 6h, or 90min if degraded |
| `feed-src-v1:<sourceId>` | `shared/feed-core.js` on every successful fetch | 14d |
| `linkedin-posts-v1` | `linkedin-sync` on the droplet | none |

## Key design decisions
- **ASSETS.fetch() rewrite** in middleware — not a 301 redirect — so
  `michael.motethansen.com` serves `/resume/` content without changing the URL.
- **ORCID publications** fetched client-side from `https://pub.orcid.org/v3.0/0000-0001-7645-5958/works`
  — no server function needed, public API supports CORS.
- **Writing feed sources**: 2 live Substack RSS feeds (ULW, Vizneo Academy) +
  LinkedIn articles. Medium and the personal Medium feed were removed.
- **LinkedIn is dynamic via KV**: `functions/api/writing.js` and the Worker read
  KV key `linkedin-posts-v1` (a JSON array), falling back to the `content/linkedin-posts.js`
  seed when empty. The `linkedin-sync/` DO job populates that key, so new LinkedIn
  articles appear with no redeploy. (LinkedIn has no public article API — that job is
  the only way to automate it.)
- **One feed core, two callers**: `shared/feed-core.js` is imported by both the Pages
  Function and the cron Worker. They used to carry byte-identical copies behind
  "keep in sync" comments, and they drifted — the per-feed item cap got fixed in one
  copy only. Never fork this logic back into the entry points.
- **KV cache strategy — per-source fallback**: the Worker (cron, hourly) and the
  Pages Function both write the FULL merged list to `writing-feed-v4`. Each source
  ALSO keeps its own last-known-good snapshot under `feed-src-v1:<sourceId>` (14d TTL).
  On rebuild, a source that fails — or that returns 200 but parses to **0 items**, i.e.
  a challenge page — is served from its snapshot rather than silently dropped. Rules:
  - a build is **complete** only when *every* source contributed posts;
  - only a complete build is cached — 6h TTL, or **90min** if any source came from a
    snapshot. Both MUST exceed the cron interval: a shorter TTL leaves an uncached
    window each hour in which every visitor request re-fetches every upstream feed.
    That shipped once (30min vs hourly cron) and Substack started returning HTTP 429;
  - an incomplete build is served but never persisted.
  The old guard only required "≥1 Substack feed loaded", so a build where Urban Life
  Works was blocked but Vizneo succeeded counted as healthy and cached a feed missing
  a whole publication for 30h. That was the "Substack articles disappeared" bug.
- **Substack edge-fetch**: `fetchFeed` requests the RSS feeds with a **real browser
  User-Agent**, **no `cf: { cacheEverything }`**, and one retry. Substack blocks
  bot-ish UAs from Cloudflare egress *intermittently and per publication* (seen as
  403 and 429), and `cacheEverything` could pin that block response at the edge. KV is
  the only cache layer; the edge does no subrequest caching. Substack serves these
  feeds 200 to a residential IP and **403 to both droplets**, so if Cloudflare is ever
  blocked outright the options are `scripts/warm-feed-cache.mjs` from a residential
  machine, or a proxy.
- **Diagnosing a missing publication**: `curl https://motethansen.com/api/writing?debug=1`
  → per-source `status` (`live` / `snapshot` / `missing`), counts, and the fetch error.
  This bypasses the merged cache and writes nothing, so it is safe to hit any time.
- **How new posts reach the site (freshness budget)**: nothing pushes to this site —
  every path is polling, so latency == poll rate.
  - **Substack: fully automatic.** Cron Worker polls hourly → new post live within ~1h.
  - **LinkedIn: automatic, twice a day, on the droplet.** `linkedin_discover.py`
    reads the **public profile page** (no login cookie — the `/pulse/` links are in
    the HTML) and hands new URLs to the existing metadata+KV pipeline. After a KV
    write that changed the count it pings the Worker `/refresh`, so the site updates
    in seconds rather than waiting for the hourly cron.
  - **Why only twice a day** (measured 2026-07-28/30): that profile page is aggressively
    **rate limited per IP**, tripping after only ~6–10 requests. Identical requests from
    a droplet went 200 (fresh) → 2/12 (after ~30) → 0/12 (after ~60), for curl, requests
    and urllib alike; it recovers once the IP is quiet. So polling more often makes
    discovery *less* reliable. `linkedin_discover.fetch_profile` retries 4× with spaced,
    jittered backoff — verified getting through from an already-throttled IP.
  - **Don't A/B headers against that wall.** A single trial looks causal but is noise
    from a probabilistic limiter; only repeated trials mean anything. Probing at all
    consumes that host's budget.
  - **Cloudflare Workers egress is blocked outright** (HTTP 999) — that is why
    discovery cannot live in the feed-refresh Worker. The droplets are fine when quiet.
  - Discovery is **best-effort**: if it's walled for a whole run, the job continues
    with `article-urls.txt` and just doesn't find new articles that time.
  - **Authorship guard**: the profile page can surface other people's posts, so a
    discovered article is only published if its JSON-LD author matches
    `LINKEDIN_AUTHOR_MATCH` (default `hansen`); curated URLs are trusted as-is.
  - Want it live immediately instead of waiting for the next run:
    `docker compose run --rm sync --add-url "https://www.linkedin.com/pulse/…"`
- **Archive page**: `/writing/` lists all articles with client-side search;
  homepage shows top 9 and links to it via a "View all N articles" button when total > 9.
- **Favicon**: SVG only (`/favicon.svg`) — works in all modern browsers and scales cleanly.

## Agents & machines
| Agent | Model | Machine | Role |
|---|---|---|---|
| Claude Code | Claude Opus 5 (1M context) | MacBook Pro (development only) | Dev agent — code, deploy |
| Codex | Codex Sonnet 4.6 | MacBook Pro (development only) | Dev agent — code, deploy |

Machines are for **development only** — production runs on the droplets and
Cloudflare. Update the model column when you switch models; it goes stale silently.

## Owner
Michael Motet Hansen — hansenmichaelmotet@gmail.com
ORCID: 0000-0001-7645-5958
