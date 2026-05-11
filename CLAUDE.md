# motethansen-site — Claude Context

## What this repo is
Personal website for **Michael Motet Hansen** (motethansen.com) and resume subdomain
(michael.motethansen.com). Hosted on **Cloudflare Pages** — static files in `public/`,
serverless logic in `functions/api/`, and a standalone scheduled Worker in
`workers/feed-refresh/`.

## Repo structure
```
public/
  index.html          — main landing page (motethansen.com)
  style.css           — shared dark theme stylesheet
  favicon.svg         — SVG favicon (mh monogram, purple-to-teal gradient)
  resume/
    index.html        — resume page (michael.motethansen.com), standalone CSS

functions/
  _middleware.js      — host-based routing: michael.motethansen.com → /resume/ (ASSETS rewrite)
  api/
    contact.js        — contact form handler → Resend API → hansenmichaelmotet@gmail.com
    writing.js        — RSS aggregator (4 feeds), KV cache key: writing-feed-v3 (6h TTL)
    publications.js   — (legacy stub, ORCID now fetched client-side in JS)

workers/
  feed-refresh/
    worker.js         — scheduled cron Worker (0 6 * * * UTC), writes KV, no TTL
    wrangler.toml     — Worker config, KV binding SITE_KV

wrangler.toml         — Pages project config, KV binding SITE_KV
deploy.sh             — manual deploy script (unsets CF_* vars, runs wrangler pages deploy + wrangler deploy)
.env                  — GITIGNORED master key file (all API keys)
.scrum/               — sprint records and backlog
```

## Deploy
```bash
bash deploy.sh
```
Deploys both the Pages site and the feed-refresh Worker in one step.
**No GitHub auto-deploy** — always deploy manually from this machine.

## Environment variables (set in Cloudflare Pages dashboard)
| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend transactional email |
| `RESEND_FROM_EMAIL` | Sender address (noreply@vizneo.com) |
| `SITE_KV` | KV namespace binding (writing feed cache) |

Local `.env` keys use `VIZNEO_CF_*` prefix to avoid wrangler auto-pickup.

## Key design decisions
- **ASSETS.fetch() rewrite** in middleware — not a 301 redirect — so
  `michael.motethansen.com` serves `/resume/` content without changing the URL.
- **ORCID publications** fetched client-side from `https://pub.orcid.org/v3.0/0000-0001-7645-5958/works`
  — no server function needed, public API supports CORS.
- **RSS feeds** (4 active): ULW Substack, Vizneo Academy Substack, ULW Medium, Vizneo Academy Medium.
  Personal Medium feed disabled (duplicates).
- **KV cache strategy**: Worker writes at 06:00 UTC with no TTL; Pages Function reads instantly.
  On cache miss, Pages Function fetches live and caches for 6h.
- **Favicon**: SVG only (`/favicon.svg`) — works in all modern browsers and scales cleanly.

## Agents & machines
| Agent | Model | Machine | Role |
|---|---|---|---|
| Claude Code | Claude Sonnet 4.6 | MacBook Pro (orchestrator) | Primary dev agent — all code, deploy |

## Owner
Michael Motet Hansen — hansenmichaelmotet@gmail.com
ORCID: 0000-0001-7645-5958
