#!/usr/bin/env bash
#
# One-shot setup for the LinkedIn sync job on a DigitalOcean droplet.
# Idempotent — safe to re-run (e.g. after `git pull`).
#
#   creates a venv, installs deps, ensures .env exists.
#   The daily cron is OPT-IN — it is NOT installed unless you pass --enable-cron,
#   so setup never starts scraping before you've validated the go-live steps.
#   Remove an installed cron with:  bash deploy/disable-cron.sh
#
# Usage (on the droplet, after cloning the repo):
#   cd /path/to/motethansen-site/linkedin-sync
#   bash deploy/setup.sh                     # prep only, no schedule
#   bash deploy/setup.sh --with-playwright   # also install headless Chromium fallback
#   bash deploy/setup.sh --enable-cron       # prep AND schedule the daily run (go-live)
#
set -euo pipefail

WITH_PLAYWRIGHT=0
ENABLE_CRON=0
for arg in "$@"; do
  case "$arg" in
    --with-playwright) WITH_PLAYWRIGHT=1 ;;
    --enable-cron) ENABLE_CRON=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

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

# 1b. optional: headless Chromium for the Playwright fallback engine
if [ "$WITH_PLAYWRIGHT" = "1" ]; then
  echo "  installing Playwright + Chromium (this pulls ~400MB)…"
  ./.venv/bin/pip install --quiet -r requirements-playwright.txt
  ./.venv/bin/playwright install chromium
  # System libs Chromium needs — requires root.
  if [ "$(id -u)" = "0" ]; then
    ./.venv/bin/playwright install-deps chromium || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo ./.venv/bin/playwright install-deps chromium || true
  else
    echo "  ! could not install system deps (no root/sudo). If Chromium fails to launch,"
    echo "    run: playwright install-deps chromium   (as root)"
  fi
  echo "  ✓ Playwright engine ready"
fi

# 2. .env
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "  ✓ created .env from .env.example — EDIT IT before the job can run"
  NEEDS_ENV=1
else
  echo "  ✓ .env already present"
fi

# 3. daily cron @ 05:30 UTC — OPT-IN (go-live only)
chmod +x deploy/run.sh deploy/disable-cron.sh
RUN="$HERE/deploy/run.sh"
CRON_LINE="30 5 * * * $RUN"
if [ "$ENABLE_CRON" = "1" ]; then
  if crontab -l 2>/dev/null | grep -Fq "$RUN"; then
    echo "  ✓ cron already installed"
  else
    ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
    echo "  ✓ installed daily cron (05:30 UTC): $CRON_LINE"
  fi
elif crontab -l 2>/dev/null | grep -Fq "$RUN"; then
  echo "  • cron is currently INSTALLED (a previous --enable-cron). Remove with:"
  echo "      bash deploy/disable-cron.sh"
else
  echo "  • cron NOT installed (opt-in). Enable at go-live with:"
  echo "      bash deploy/setup.sh --enable-cron"
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
echo "  •  Go live (schedule the daily run):"
echo "       bash deploy/setup.sh --enable-cron"
echo "  •  Logs: /var/log/linkedin-sync.log (or $HERE/linkedin-sync.log)"
