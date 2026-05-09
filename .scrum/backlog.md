# motethansen-site — Backlog

## Sprint 1 (current)

- [ ] **UX/Design review** — define visual direction, typography, colour system, layout grid. Review 2–3 reference sites before committing to a component structure.
- [ ] **RSS Workers** — implement Cloudflare Workers to fetch and edge-cache highlight cards from:
  - Vizneo Academy (Substack)
  - urbanlife.works (Substack)
  - Medium publications
- [ ] **Resume page** — build mmichael.motethansen.com as a separate route in the same repo. Data from LinkedIn export → JSON Resume schema. Design to match main site aesthetic.
- [ ] **Local dev workflow** — wire up `wrangler dev` so the full site (Workers + static) runs locally. Document clone → dev → deploy steps in README.

## Backlog

- [ ] Custom domain: motethansen.com → Cloudflare Pages
- [ ] Research section: journal publications + active projects
- [ ] Project cards: winedragons.asia, urbanlife.works, ref.team
- [ ] Analytics: Cloudflare Web Analytics (privacy-first, no cookies)
- [ ] Dark mode toggle
- [ ] OG images for social sharing

## Done

- [x] Scaffold index.html + style.css + wrangler.toml
- [x] Deploy to Cloudflare Pages (motethansen-site.pages.dev)
