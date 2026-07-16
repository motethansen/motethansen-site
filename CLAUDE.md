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
    writing.js        — feed aggregator: live Substack RSS + LinkedIn (from KV). Cache key: writing-feed-v4 (6h).
                        ?all=1 returns full list; default returns top 9. Response includes { posts, total, cached }.
    publications.js   — (legacy stub, ORCID now fetched client-side in JS)

workers/
  feed-refresh/
    worker.js         — scheduled cron Worker (0 20 * * * UTC), writes KV with 30h backstop TTL
    wrangler.toml     — Worker config, KV binding SITE_KV

linkedin-sync/        — Python job (runs on DigitalOcean) — scrapes LinkedIn articles → KV key linkedin-posts-v1
  linkedin_sync.py    — CLI: normalise → merge (union by URL) → write KV. Flags: --from-file, --dry-run, --print
  linkedin_source.py  — the fragile LinkedIn fetch layer (Voyager REST + JSON-LD fallback). Isolated on purpose.
  articles.sample.json— starter data for --from-file (also the seed source of truth)
  README.md           — DO deploy options + cookie/maintenance notes

wrangler.toml         — Pages project config, KV binding SITE_KV
deploy.sh             — manual deploy script (unsets CF_* vars, wrangler pages deploy + wrangler deploy, busts KV)
.env                  — GITIGNORED master key file (all API keys)
.scrum/               — sprint records and backlog
```

## Deploy
```bash
bash deploy.sh
```
Deploys both the Pages site and the feed-refresh Worker, then deletes KV key
`writing-feed-v4` to force a fresh rebuild on the next request.
**No GitHub auto-deploy** — always deploy manually from this machine.

## Environment variables (set in Cloudflare Pages dashboard)
| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend transactional email |
| `RESEND_FROM_EMAIL` | Sender address (noreply@vizneo.com) |
| `SITE_KV` | KV namespace binding (writing feed cache + LinkedIn posts) |

Local `.env` keys use `VIZNEO_CF_*` prefix to avoid wrangler auto-pickup.
The `linkedin-sync/` job has its own `.env` (see `linkedin-sync/.env.example`) with
`CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_API_TOKEN`, and the `LINKEDIN_*` cookie vars.

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
- **KV cache strategy + poison guard**: the Worker (cron, 20:00 UTC) and the Pages
  Function both write the FULL merged list to `writing-feed-v4`. Critical rule:
  **only cache a "healthy" build** (≥1 Substack feed loaded). A build where every
  Substack fetch fails is served but never persisted — this prevents a transient
  Substack outage from poisoning the cache with a LinkedIn-only feed (the bug that
  hid all Substack posts). Worker write also carries a 30h backstop TTL so any bad
  state self-heals instead of sticking forever.
- **Archive page**: `/writing/` lists all articles with client-side search;
  homepage shows top 9 and links to it via a "View all N articles" button when total > 9.
- **Favicon**: SVG only (`/favicon.svg`) — works in all modern browsers and scales cleanly.

## Agents & machines
| Agent | Model | Machine | Role |
|---|---|---|---|
| Claude Code | Claude Sonnet 4.6 | MacBook Pro (orchestrator) | Primary dev agent — all code, deploy |

## Owner
Michael Motet Hansen — hansenmichaelmotet@gmail.com
ORCID: 0000-0001-7645-5958
