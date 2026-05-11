# Sprint 1 — Initial Build & Deployment
**Date:** 2026-05-09
**Agent:** Claude Sonnet 4.6 (Claude Code)
**Machine:** MacBook Pro (orchestrator)
**Status:** ✅ Completed

---

## Goal
Build and deploy the full motethansen.com website from scratch on Cloudflare Pages,
including dark-theme redesign, resume subdomain, contact form, writing feed, and
daily refresh Worker.

---

## Tasks Completed

### Infrastructure & Deployment
- [x] `354c996` Initial scaffold — index.html, style.css, wrangler.toml, .scrum/backlog.md
- [x] `762e027` Move site files into `public/` — align with Cloudflare Pages output dir
- [x] `1f5e8fe` Add `deploy.sh` — wrangler pages deploy shortcut; unsets CF_* vars to avoid OAuth conflict
- [x] `0d2e9f0` Add `.gitignore` — exclude .env, .wrangler/, .dev.vars, node_modules
- [x] Resolve Cloudflare Pages project conflict — delete old Workers project, recreate as Pages project
- [x] Wire KV namespace (`SITE_KV`, ID: `1b97cac1e10d4bcaaa1bef301a86af26`) to both Pages and Worker

### Frontend — Main Site
- [x] `94eccbf` Wave 1 frontend redesign — full HTML/CSS for motethansen.com
- [x] `df56867` Dark theme — gradient hero, card hover effects, visual depth
  - `--color-bg: #0a0a0f`, `--color-accent: #7b61ff`, `--color-teal: #2dd4bf`
  - Hero radial-gradient glows + dot-grid texture
  - Card accent top-border reveal on hover
- [x] `2d475da` Fix name spelling — Michael Motet Hansen (missing 't')
- [x] `98f06af` Distinguish urbanlife.works (website) from Substack blog
- [x] `00280a2` Correct Substack URL to urbanlifeworks.substack.com

### Resume Page
- [x] `cc03a0b` Wave 2 resume page — public/resume/index.html
- [x] `004b847` Full resume rebuild from LinkedIn — experience, education, publications, languages
- [x] `ee3b12e` Resume: contact form, remove email, add motethansen.com back link

### Features
- [x] `80057f7` Cloudflare Pages Functions — ORCID publications + RSS writing feed (initial)
- [x] `b106c53` Contact form + Pages Function (/api/contact) + Mastodon link (me.dm/@motethansen)
- [x] `e215c68` Wire Resend API — contact form sends email to hansenmichaelmotet@gmail.com
- [x] `6af9f33` Writing feed — multi-feed RSS aggregator, images, pub link pills, 3-col card grid
  - Feeds: ULW Substack, Vizneo Academy Substack, ULW Medium, Vizneo Academy Medium, Personal Medium
- [x] `fe0abe6` Daily feed-refresh Worker — cron `0 6 * * *`, writes to KV, no TTL
- [x] `1ce9f5e` Add Vizneo project card + ref.team spotlight section + "Work with us" → #contact

### Project Cards
- [x] `1bb43ab` Add Academic Tool card (EdTech, academictool.vizneo.com)
- [x] `edbefdc` Fix Academic Tool URL → academictool.vizneo.com

### Routing
- [x] `f7aef55` Pages middleware — redirect michael.motethansen.com → /resume/ (initial 301 approach)
- [x] `02dbd6e` Resume modern dark redesign + fix routing via ASSETS.fetch() internal rewrite
  - Replaced 301 redirect with `context.env.ASSETS.fetch()` — serves /resume/ content without URL change

---

## Blockers Resolved
- Cloudflare new project ran `npx wrangler deploy` (Workers) instead of Pages deploy — deleted and recreated
- `account_id` not supported in Pages `wrangler.toml` — removed
- `.env` `CF_API_TOKEN` overriding wrangler OAuth — renamed to `VIZNEO_CF_*` prefix
- michael.motethansen.com middleware 301 redirect not serving static assets — switched to ASSETS.fetch()
