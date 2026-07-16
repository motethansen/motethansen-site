#!/usr/bin/env bash
#
# One-shot setup for the LinkedIn sync job on a DigitalOcean droplet.
# Idempotent — safe to re-run (e.g. after `git pull`).
#
#   creates a venv, installs deps, ensures .env exists, installs a daily cron.
#
# Usage (on the droplet, after cloning the repo):
#   cd /path/to/motethansen-site/linkedin-sync
#   bash deploy/setup.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$HERE"
echo "▶ linkedin-sync setup in: $HERE"

# 1. venv + dependencies
if [ ! -d .venv ]; then
  echo "  creating virtualenv…"
  python3 -m venv .venv
fi
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt
echo "  ✓ venv + dependencies"

# 2. .env
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "  ✓ created .env from .env.example — EDIT IT before the job can run"
  NEEDS_ENV=1
else
  echo "  ✓ .env already present"
fi

# 3. daily cron @ 05:30 UTC (before the site's ~06:00 read window)
chmod +x deploy/run.sh
RUN="$HERE/deploy/run.sh"
CRON_LINE="30 5 * * * $RUN"
if crontab -l 2>/dev/null | grep -Fq "$RUN"; then
  echo "  ✓ cron already installed"
else
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  echo "  ✓ installed cron: $CRON_LINE"
fi

echo
echo "Done. Next steps:"
if [ "${NEEDS_ENV:-0}" = "1" ]; then
  echo "  1. Edit $HERE/.env  (CF_API_TOKEN, LINKEDIN_LI_AT, …)"
fi
echo "  •  Seed KV once (no scraping needed):"
echo "       ./.venv/bin/python linkedin_sync.py --from-file articles.sample.json"
echo "  •  Test the scrape without writing:"
echo "       ./.venv/bin/python linkedin_sync.py --dry-run"
echo "  •  Inspect what's in KV:"
echo "       ./.venv/bin/python linkedin_sync.py --print"
echo "  •  Logs: /var/log/linkedin-sync.log (or $HERE/linkedin-sync.log)"
