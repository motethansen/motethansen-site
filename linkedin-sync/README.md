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
```

`--from-file` also lets you hand-maintain the list (edit a JSON file, run it) if
you ever want to bypass scraping entirely — same schema as `articles.sample.json`.

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

nano .env                     # fill CF_API_TOKEN + LINKEDIN_LI_AT (+ JSESSIONID)

# seed KV once so the site has data immediately (no scraping needed):
./.venv/bin/python linkedin_sync.py --from-file articles.sample.json
```

The cron entry runs `deploy/run.sh` daily, which logs to `/var/log/linkedin-sync.log`
(or `linkedin-sync/linkedin-sync.log` if `/var/log` isn't writable). Re-run
`bash deploy/setup.sh` after each `git pull` to pick up dependency changes.

To update later: `cd /opt/motethansen-site && git pull && cd linkedin-sync && bash deploy/setup.sh`.

### systemd timer (alternative to cron)
Prefer systemd? Unit files are in `deploy/systemd/`. Edit the `ExecStart` path,
then:
```bash
sudo cp deploy/systemd/linkedin-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now linkedin-sync.timer
systemctl list-timers linkedin-sync.timer     # confirm next run
```
(If you use systemd, remove the cron line `setup.sh` added, to avoid double runs.)

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
