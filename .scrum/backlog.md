# motethansen-site — Backlog
_Last updated: 2026-07-16_

---

## Done (Sprint 1 — 2026-05-09)
- [x] Scaffold index.html + style.css + wrangler.toml
- [x] Deploy to Cloudflare Pages (motethansen.com)
- [x] Dark theme — gradient hero, card hover effects, visual depth
- [x] Contact form + Resend API integration
- [x] Mastodon link (me.dm/@motethansen)
- [x] Writing feed — 4 RSS feeds, images, pub link pills, card grid
- [x] Daily feed-refresh Worker (cron 06:00 UTC, KV cache)
- [x] Vizneo + ref.team project cards and spotlight section
- [x] Academic Tool project card (EdTech)
- [x] Resume page — public/resume/index.html (dark, standalone CSS)
- [x] michael.motethansen.com → /resume/ via ASSETS.fetch() middleware rewrite
- [x] deploy.sh — one-command deploy for Pages + Worker
- [x] .gitignore — exclude .env, .wrangler/, secrets
- [x] Custom domain: motethansen.com → Cloudflare Pages
- [x] Research section: ORCID publications + active projects
- [x] Project cards: winedragons.asia, urbanlife.works, ref.team, vizneo.com, academictool.vizneo.com

## Done (Sprint 2 — 2026-05-09 to 2026-05-11)
- [x] ORCID live publications (client-side fetch, both pages)
- [x] #resume hash redirect → michael.motethansen.com
- [x] LinkedIn URL corrected → /in/michaelmotethansen/
- [x] Location: "Based in Southeast Asia"
- [x] ref.team / Vizneo relationship clarified
- [x] Research lede: urban innovation + smart city
- [x] Hero copy updated
- [x] Wine Dragons + Urban Life Works card descriptions updated
- [x] Academic Tool: remove institution name from card
- [x] Resume summary: PhD completed (Integrated Science, Thammasat)
- [x] DTU degree: Electronic Engineering (not Electrical)
- [x] JCU subjects + lecturer section updated (Business Innovation, Lean UX, Agile PM)
- [x] JCU: cross-subject Design Sprint every 3 months added
- [x] Skills: Smart Cities (Research) + Design Thinking (Delivery)
- [x] Personal Medium feed disabled (duplicates)
- [x] Favicon: SVG mh monogram, purple-to-teal gradient
- [x] Resume section: background summary + "Read my resume here" link

## Done (Sprint 3 — 2026-07-16)
- [x] Writing feed cache poison guard (only cache healthy builds; 30h backstop TTL)
- [x] Cache key → `writing-feed-v4` (stores full merged list)
- [x] Dynamic LinkedIn via KV `linkedin-posts-v1` (seed fallback)
- [x] `/writing/` archive page + client-side search + "View all N articles" button
- [x] `/api/writing?all=1` full list; response `{ posts, total, cached }`
- [x] Substack edge-fetch fix — browser UA + drop `cf.cacheEverything`
- [x] `linkedin-sync/` Python job: adaptive HTTP→Playwright engine, capture harness,
      Resend failure alerts, droplet cron/systemd deploy, pytest suite (20 pass)
- [x] CLAUDE.md updated (guard, dynamic LinkedIn, Substack edge-fetch, scraper)
- See `sprint-3.md` for full detail + go-live steps.

---

## Backlog (Upcoming)

### High priority
- [ ] **LinkedIn scraper go-live (Sprint 4)** — code is on `main`; KV still holds the
      3-article seed. Operator steps (secrets + droplet), full checklist in `sprint-3.md`:
  - [ ] CF API token (Workers KV: Edit), `li_at` cookie, Resend key → droplet `.env`
  - [ ] `bash deploy/setup.sh`; `--test-alert`; seed via `--from-file`
  - [ ] Capture decision point (`--capture`): HTTP vs Playwright — send capture back to finalize parser
  - [ ] `deploy/run.sh` go-live; verify KV + live site + failure alert
- [ ] **Substack proxy fallback** — only if Substack hard-blocks Cloudflare IPs
      (current UA/edge-cache fix works; guard keeps failure graceful)
- [ ] **Analytics** — Cloudflare Web Analytics (privacy-first, no cookies)
- [ ] **OG images** — social share previews for motethansen.com and michael.motethansen.com
- [ ] **Resend domain verification** — verify vizneo.com in Resend dashboard so noreply@vizneo.com sends correctly
- [ ] **ref.team page** — content and link audit; ensure ref.team site is live and linked correctly

### Medium priority
- [ ] **Mobile layout review** — test writing grid, pub-list, and timeline on small screens
- [ ] **Print CSS review** — verify resume print/PDF output in Chrome and Safari
- [ ] **Writing feed: date display** — show relative dates (e.g. "3 days ago") for recent posts
- [ ] **Manual refresh endpoint docs** — document the `/refresh?secret=...` URL for triggering feed updates outside cron

### Low priority / Ideas
- [ ] Dark mode toggle (currently always dark)
- [ ] Wine Dragons project page
- [ ] UrbanLife Works project page
- [ ] Add more ORCID paper details (abstract, co-authors) on click/expand
- [ ] Local dev workflow — wire up `wrangler dev` for full local stack
