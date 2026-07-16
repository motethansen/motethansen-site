# linkedin-sync

Keeps the website's LinkedIn articles current without redeploys.

It collects your published LinkedIn articles, merges them with what's already
stored, and writes the result to **Cloudflare KV** key `linkedin-posts-v1`. The
site's `functions/api/writing.js` and the feed-refresh Worker read that key and
merge it with the live Substack feeds — so a new LinkedIn article appears on
motethansen.com automatically.

```
LinkedIn ──scrape──▶ linkedin_sync.py ──▶ Cloudflare KV (linkedin-posts-v1)
                          │                        │
                     merge w/ existing        read by writing.js + worker
                                                   │
                                          motethansen.com /api/writing
```

## Why this exists (and the honest caveat)

LinkedIn has **no official public API** for reading an individual's published
articles, and it defends against scraping. The fetch layer (`linkedin_source.py`)
is therefore the one fragile part — it can break when LinkedIn changes its markup
or when the auth cookie expires. Everything else (normalise → merge → push to KV)
is stable and isolated, so repairs only ever touch `fetch_articles()`.

Two safeguards are built in:
- A scrape that returns **0 articles** aborts **without touching KV** (an empty
  result is almost always an auth wall, not "no articles").
- Merge is a **union by URL** — a partial scrape never deletes stored history.

If you'd rather not maintain a scraper at all, use `--from-file` (below).

## Setup

```bash
cd linkedin-sync
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then fill it in
```

Fill `.env`:

| Var | Where to get it |
|---|---|
| `CF_ACCOUNT_ID` | already filled — this site's account |
| `CF_KV_NAMESPACE_ID` | already filled — the SITE_KV namespace |
| `CF_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → create with **Workers KV Storage : Edit** |
| `LINKEDIN_PROFILE` | your public profile id, e.g. `michaelmotethansen` |
| `LINKEDIN_LI_AT` | browser DevTools → Application → Cookies → linkedin.com → `li_at` (while logged in) |
| `LINKEDIN_JSESSIONID` | same place, `JSESSIONID` (optional but improves reliability) |

## Usage

```bash
# Push a known-good starter set to KV (no scraping) — do this once to seed:
python linkedin_sync.py --from-file articles.sample.json

# Scrape LinkedIn, merge, push:
python linkedin_sync.py

# See what would happen without writing:
python linkedin_sync.py --dry-run

# Inspect what's currently in KV:
python linkedin_sync.py --print

# Send a test failure-alert email (checks your Resend config):
python linkedin_sync.py --test-alert
```

`--from-file` also lets you hand-maintain the list (edit a JSON file, run it) if
you ever want to bypass scraping entirely — same schema as `articles.sample.json`.

### Flags

| Flag | Purpose |
|---|---|
| `--dry-run` | Do everything except the KV write; print the merged result |
| `--print` | Print the current KV contents and exit |
| `--engine {auto,http,playwright}` | Fetch engine. `auto` (default) = HTTP, then Playwright if HTTP is walled |
| `--capture DIR` | Save every raw LinkedIn response to `DIR/` (diagnose walls) |
| `--from-capture DIR` | Re-parse a captured `DIR/` **offline** (no network) — for tuning the parser |
| `--from-file PATH` | Load articles from a JSON file instead of scraping |
| `--test-alert` | Send a test failure-alert email and exit |

## How the scraper works (adaptive engine)

LinkedIn has no article API and blocks non-browser requests from datacenter IPs.
`fetch_articles` (in `linkedin_source.py`) therefore tries two engines:

1. **HTTP** — Voyager JSON, then the author page's JSON-LD. Cheap; often walled.
2. **Playwright** (`linkedin_playwright.py`) — real headless Chromium with your
   `li_at` cookie; renders the page and extracts articles from JSON-LD or the DOM.
   Only used when HTTP comes back empty/challenged. Needs `--with-playwright` setup.

**Capture-first tuning.** Don't guess LinkedIn's markup — capture it, then iterate
the parser offline:

```bash
# 1. On the droplet, see what LinkedIn actually returns for each engine:
python linkedin_sync.py --engine http       --capture ./cap-http --dry-run
python linkedin_sync.py --engine playwright  --capture ./cap-pw   --dry-run
#    Inspect ./cap-*/ : real article data ⇒ that engine works;
#    a login/999/challenge page ⇒ use the other engine.

# 2. Iterate the parser against the capture with NO network (fast, safe):
python linkedin_sync.py --from-capture ./cap-pw --dry-run
```

## Failure alerts

If `RESEND_API_KEY` + `ALERT_EMAIL` are set, a **scheduled** run that fails or
scrapes 0 articles (the usual sign of an expired `li_at`) emails you via Resend
(`notify.py`). Manual `--dry-run` / `--from-file` / `--from-capture` runs never
email — they show the error at your terminal. Verify with `--test-alert`.

## Tests

```bash
pip install -r requirements-dev.txt
pytest                       # from the linkedin-sync/ dir
```
Covers normalise/date/merge, the Resend alert, the JSON-LD/DOM parsers, the
capture round-trip, and (where Chromium is installed) a real-browser DOM test.

## Verify it worked

```bash
python linkedin_sync.py --print                 # KV contents
curl -s https://motethansen.com/api/writing?all=1 | python3 -m json.tool | head
```

New LinkedIn posts appear within the site's 6h cache window (or immediately after
the next `deploy.sh`, which busts the cache).

## Deploying on DigitalOcean (droplet cron — current setup)

On the droplet, clone the repo and run the setup script. It creates the venv,
installs deps, ensures a `.env`, and installs a daily cron (05:30 UTC).

```bash
git clone git@github.com:motethansen/motethansen-site.git /opt/motethansen-site
cd /opt/motethansen-site/linkedin-sync
bash deploy/setup.sh          # idempotent — safe to re-run after `git pull`

nano .env                     # fill CF_API_TOKEN, LINKEDIN_LI_AT (+ JSESSIONID),
                              #      RESEND_API_KEY, ALERT_EMAIL

# seed KV once so the site has data immediately (no scraping needed):
./.venv/bin/python linkedin_sync.py --from-file articles.sample.json
```

Add the headless-browser fallback if HTTP is walled (see "Bring the scraper
online" below):

```bash
bash deploy/setup.sh --with-playwright   # installs Chromium (~400MB) + system deps
```

**The daily cron is opt-in.** `setup.sh` does NOT schedule anything on its own —
it only preps the venv/deps/.env, so you can validate the go-live steps first
without a scheduled job firing. Schedule it (05:30 UTC) only when you're ready:

```bash
bash deploy/setup.sh --enable-cron   # go-live: installs the daily cron
bash deploy/disable-cron.sh          # stop scheduled scraping again
```

Once enabled, the cron runs `deploy/run.sh` daily, logging to
`/var/log/linkedin-sync.log` (or `linkedin-sync/linkedin-sync.log` if `/var/log`
isn't writable). Re-run `bash deploy/setup.sh` after each `git pull` to pick up
dependency changes — it won't touch the cron unless you pass `--enable-cron`.

To update later: `cd /opt/motethansen-site && git pull && cd linkedin-sync && bash deploy/setup.sh`.

### Bring the scraper online (once, on the droplet)

1. **Alerting works:** `./.venv/bin/python linkedin_sync.py --test-alert` → check inbox.
2. **KV path works:** `--from-file articles.sample.json` then `--print`, and
   `curl -s 'https://motethansen.com/api/writing?all=1'` shows the seed articles.
3. **See what LinkedIn returns:** `--engine http --capture ./cap --dry-run`.
   - Real articles ⇒ leave engine on `auto`, done.
   - A wall ⇒ `bash deploy/setup.sh --with-playwright`, then
     `--engine playwright --capture ./cap-pw --dry-run`.
4. **Real scrape (no write):** `--dry-run` returns your articles (count > 3).
5. **Go live:** `bash deploy/run.sh` → tail the log; confirm KV + the live site update.
   Then schedule it: `bash deploy/setup.sh --enable-cron`. (Undo: `bash deploy/disable-cron.sh`.)
6. **Alert works for real:** temporarily break `LINKEDIN_LI_AT`, run `deploy/run.sh`,
   confirm the failure email — then restore the cookie.

### systemd timer (alternative to cron)
Prefer systemd? Unit files are in `deploy/systemd/`. Edit the `ExecStart` path,
then:
```bash
sudo cp deploy/systemd/linkedin-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now linkedin-sync.timer
systemctl list-timers linkedin-sync.timer     # confirm next run
```
(The cron is opt-in, so there's nothing to remove unless you ran
`setup.sh --enable-cron`; if you did, run `bash deploy/disable-cron.sh` to avoid double runs.)

### Other DO options (not used here)

#### DO App Platform scheduled job
Create a **Job** component (not a Service) with an attached schedule:
- Source: this repo, source dir `linkedin-sync`
- Build: `pip install -r requirements.txt`
- Run: `python linkedin_sync.py`
- Schedule (cron): `30 5 * * *`
- Env vars: the same keys as `.env`, marked **encrypted**.

#### DO Functions (serverless)
Wrap `main()` in a function handler and deploy with `doctl serverless deploy`,
then attach a scheduled trigger. `requests` is the only runtime dep. Store the
secrets as function parameters/env. (Cron on a droplet or App Platform Job is
less fuss for a once-a-day task.)

## Maintenance

- **Sync returns 0 / errors about a challenge** → the `li_at` cookie expired.
  Grab a fresh one from your browser and update `LINKEDIN_LI_AT`.
- **LinkedIn changed its response shape** → adjust `_article_from_voyager` /
  `_fetch_via_html` in `linkedin_source.py`. Nothing else needs to change.
