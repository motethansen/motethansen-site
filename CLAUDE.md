# motethansen-site — Claude Context

## What this repo is
Personal website for **Michael Motet Hansen** (motethansen.com, resume at michael.motethansen.com) on **Cloudflare Pages**, plus
the **shared articles service** (Worker `motethansen-articles`) that also serves **vizneo.com**. Articles are written in the web
editor at `/admin`; Substack posts are pulled hourly by the thinkpad. LinkedIn is no longer used (it challenges every
non-browser client since 2026-11-13); the 9 old LinkedIn articles are kept as linked-out entries.

## Repo structure
```
public/                 static site: index.html (home, top 9 posts), writing/index.html (archive + search), resume/, style.css
functions/              Pages Functions
  _middleware.js        michael.motethansen.com -> /resume/ (ASSETS rewrite)
  admin/[[path]].js     /admin, /admin/*              -> articles service (editor page)
  api/admin/[[path]].js /api/admin/*                  -> articles service (sign-in, article CRUD, preview, image upload/import)
  api/ingest/[[path]].js /api/ingest/*                -> articles service (bearer-token push of Substack posts)
  media/[[path]].js     /media/*                      -> articles service (uploaded images from R2)
  writing/[[path]].js   /writing/<slug>/, rss.xml, index.json -> articles service; unknown slug = real 404
  api/writing.js        the site's article list: reads /writing/index.json from the service, newest first, proxies images
  api/health.js         Vantage health (reads KV sync records + pings the service; no third-party requests)
  api/contact.js        contact form -> Resend; api/publications.js legacy stub; img.js first-party image proxy
shared/                 admin-core.js (sessions, credentials, throttle), admin-http.js (cookies, origin check), health-core.js
workers/articles/       THE SERVICE (see below): src/, admin-ui/ (editor page), migrations/, wrangler.toml
scripts/substack_sync.py  hourly Substack pull (runs on the thinkpad)
tests/                  node --test (needs `npm install` in workers/articles/ for markdown-it); scripts/test_substack_sync.py (pytest)
wrangler.toml           Pages config: KV SITE_KV, service binding ARTICLES
deploy.sh               manual deploy: articles service (+ D1 migrations) -> Pages -> verify
```

## The articles service (`workers/articles/`)
Worker `motethansen-articles`, **no public URL**, reached by service binding `ARTICLES` from this Pages project and from the
vizneowebsite Worker. It tells sites apart by the request's host (`siteOf`), so both sites forward requests untouched.
- **Storage:** D1 `motethansen-articles` (migrations in `migrations/`, applied by `deploy.sh` with `wrangler d1 migrations`),
  R2 `motethansen-media` (images served at `/media/yyyy/mm/<uuid>.<ext>`), KV SITE_KV (sign-in throttle, sync records).
- **Editor** (`/admin/`): served from the Worker's own assets (`admin-ui/`, `run_worker_first`) so every site shares one copy.
  List, Markdown with live preview, toolbar, image upload/paste, cover, tags, slug, date, "Publish on" sites, draft/publish/unpublish/delete.
  **Pasting a web page converts it to Markdown** (`html2md.js`) and copies LinkedIn/Substack images into R2
  (`POST /api/admin/media/import`: https + exact host allowlist, no redirects, 5 MB, magic-byte check). Ctrl/Cmd+Shift+V pastes plain text.
- **Safety:** raw HTML in Markdown is escaped; unsafe URLs dropped; images only from `/media/` or https. Sign-in: Worker secrets
  `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, HMAC cookie 12 h, 5 failures / 15 min lockout per IP, same-origin check on
  writes, strict CSP on `/admin`. Pages itself holds no admin secrets. Credentials file on the MacBook: `~/.config/motethansen/admin-credentials`.
- **Sites:** `ENABLED_SITES` / `SITES` / `EXTERNAL_SOURCES` in `src/sites.js`; page chrome per site in `src/layouts.js`.
  motethansen.com keeps its static `/writing/` archive page; vizneo.com's `/writing/` is rendered by the service.
- **Linked-out entries** (Substack, legacy LinkedIn): rows with `external_url`/`source`/`platform`; listed on the sites their source is
  configured for (Vizneo Academy -> both, Urban Life Works -> motethansen.com), link out, no page, no RSS item. A hidden one stays hidden.

## Substack
Substack answers Cloudflare's IPs with HTTP 429 (sometimes for a day), so **the site never fetches it**. `scripts/substack_sync.py`
runs hourly on the **thinkpad** (`~/.config/systemd/user/substack-sync.timer`, copy at `~/.local/bin/`, token in
`~/.config/motethansen/ingest-token`) and pushes both feeds to `POST /api/ingest/external` (bearer `INGEST_TOKEN`, a Worker secret).
Upserts by address, never deletes. The **mac-mini cannot be used**: it cannot reach motethansen.com/vizneo.com (dual en0/en1 route on
192.168.0.0/24, see the netwatch notes). `/api/health` is degraded if either source has not synced for 3 h; Vantage entity `motethansen-content`.

## Deploy
```bash
bash deploy.sh        # from main: service (+ migrations) -> Pages -> verify. Manual; no GitHub auto-deploy.
```
`wrangler pages deploy` from any branch other than `main` goes to a **preview** URL (`<branch>.motethansen-site.pages.dev`), a safe place
to test; production needs `main`. The Worker has no branches: deploying it from a branch changes production. vizneo.com is a separate
repo (GitLab `vizneowebsite`): `npm run build && npm run deploy` (build first: the Vite plugin generates the deployed config).
Pages serves the **home page with 200 for unknown paths** (no 404.html), so catch-all functions must return their own 404.
Python `urllib` with its default User-Agent gets 403 from Cloudflare here; always send a browser-like UA to the site's own endpoints.

## Tests
`node --test tests/` (47 incl. security rules; mutation-check new ones) and `python -m pytest scripts`. UI behaviour needs a real browser:
pyenv 3.10.13 Playwright with `executable_path` of a cached `chromium_headless_shell`; the admin CSP forbids string `wait_for_function`
(poll instead); mint a short-lived session cookie with `signSession` rather than typing the password; macOS `End` scrolls, use Meta+ArrowDown.

## KV (namespace SITE_KV, id 1b97cac1e10d4bcaaa1bef301a86af26)
| Key | Written by | TTL |
|---|---|---|
| `admin-throttle:<ip>` | service, failed sign-ins | 15 min |
| `external-sync-v1:<source>` | service, on each Substack push | 7 d |
Left over from the retired feed pipeline (harmless, can be deleted): `writing-feed-v4`, `feed-src-v1:*`, `feed-status-v1`, `linkedin-posts-v1`.

## Environment (Pages dashboard)
`RESEND_API_KEY`, `RESEND_FROM_EMAIL` (noreply@vizneo.com), `MOTETHANSEN_TURNSTILE_SECRET` for the contact form. Local `.env` is gitignored.

## Key design decisions
- **ASSETS.fetch() rewrite** in middleware, not a 301, so `michael.motethansen.com` serves `/resume/` without changing the URL.
- **ORCID publications** are fetched client-side from `pub.orcid.org` (public API, CORS).
- **Dev machines are for development only**; production work runs on a droplet or in Cloudflare. The one exception is the Substack pull,
  which needs a non-Cloudflare IP and runs on the thinkpad (fleet server).
- **Droplet 188.166.215.225 (WD-Ubuntu)** used to run the LinkedIn sync; its timers are disabled and its `/opt/motethansen-site` checkout is unused.
