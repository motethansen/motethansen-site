# Sprint 2 — Content Accuracy & UX Polish
**Dates:** 2026-05-09 – 2026-05-11
**Agent:** Claude Sonnet 4.6 (Claude Code)
**Machine:** MacBook Pro (orchestrator)
**Status:** ✅ Completed

---

## Goal
Correct all content inaccuracies, update descriptions to match current professional
reality, improve UX (ORCID live feed, #resume redirect, favicon), and deploy each
fix incrementally.

---

## Tasks Completed

### Routing & Navigation
- [x] `0102874` `#resume` hash → redirects to michael.motethansen.com
  - Nav "Resume" link opens michael.motethansen.com in new tab
  - JS: visiting motethansen.com/#resume auto-redirects client-side
- [x] `da02516` Resume section — replace redirect-only lede with background summary + "Read my resume here" link

### Research & Publications
- [x] `0102874` ORCID live publications — fetch `pub.orcid.org/v3.0/0000-0001-7645-5958/works` client-side
  - Renders 5 papers: year badge, type tag, journal (teal), DOI link
  - Applied to both main page (`#publications-list`) and resume page (`#resume-pubs`)
  - Replaces static placeholder text on resume page
- [x] `4006f48` Research section lede — add urban innovation and citizen-centric smart city research

### Content Fixes — Main Site
- [x] `c95a217` LinkedIn URL corrected → https://www.linkedin.com/in/michaelmotethansen/
- [x] `cb050d6` Location: "Based in the Nordics" → "Based in Southeast Asia" (hero + meta + resume)
- [x] `4006f48` ref.team: tag "Practice" → "Partnership"; description updated to innovation + business scalability + workshops
- [x] `4006f48` ref.team spotlight lede: links both ref.team and Vizneo with correct relationship
- [x] `4006f48` Vizneo card: "business behind ref.team" → "consulting practice operating under ref.team"
- [x] `a168061` Hero intro: new copy — "Bridging the gap between AI innovation and human potential…"
- [x] `a168061` Wine Dragons card: updated to private dining/wine events + AI sommelier description
- [x] `a168061` Urban Life Works card: updated to community-driven marketplace for urban produce, wellness, senior living
- [x] `a168061` Meta/OG descriptions updated to match hero
- [x] `25455d6` Academic Tool card: remove "Built for Thammasat University"

### Content Fixes — Resume Page
- [x] `1d8112b` Summary: "PhD candidate" → PhD completed — "PhD in Integrated Science from Thammasat University"
- [x] `950022e` DTU education: "BSc. Electrical Engineering" → "BSc. Electronic Engineering"
- [x] `23c7712` JCU Adjunct Lecturer: subjects updated to Business Innovation, Lean UX, Agile Project Management; removed repetition
- [x] `d652785` JCU: add "Plans and co-manages the cross-subject Design Sprint held every three months"
- [x] `7c9176a` JCU: remove "GV" prefix from Design Sprint

### Skills (Resume)
- [x] `fc730e7` Research skills: add Smart Cities tag
- [x] `fc730e7` Delivery skills: add Design Thinking tag

### Writing Feed
- [x] `d737815` Disable personal Medium feed (motethansen.medium.com) — duplicates publication feeds
  - KV cache cleared via Cloudflare API to force immediate re-fetch
  - Personal Medium pill link removed from main page

### Favicon
- [x] `24c180c` Create `/public/favicon.svg` — "mh" monogram, purple-to-teal gradient, dark rounded square
  - Added `<link rel="icon">` + `<link rel="apple-touch-icon">` to both HTML pages

---

## Deployments
All tasks deployed via `bash deploy.sh` on MacBook Pro — Cloudflare Pages +
feed-refresh Worker deployed together each time.

---

## Active RSS Feeds (post-sprint)
| ID | Publication | Platform | Feed URL |
|---|---|---|---|
| ulw-substack | Urban Life Works | Substack | https://urbanlifeworks.substack.com/feed |
| va-substack | Vizneo Academy | Substack | https://vizneoacademy.substack.com/feed |
| ulw-medium | Urban Life Works | Medium | https://medium.com/feed/urban-life-works |
| va-medium | Vizneo Academy | Medium | https://medium.com/feed/vizneo-academy |
| ~~personal-medium~~ | ~~Michael Motet Hansen~~ | ~~Medium~~ | ~~disabled~~ |
