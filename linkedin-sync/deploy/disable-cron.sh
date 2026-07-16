#!/usr/bin/env bash
#
# Remove the linkedin-sync daily cron entry (stops scheduled scraping).
# Safe to run whether or not the cron is currently installed.
# Re-enable later with:  bash deploy/setup.sh --enable-cron
#
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
RUN="$HERE/deploy/run.sh"

if crontab -l 2>/dev/null | grep -Fq "$RUN"; then
  crontab -l 2>/dev/null | grep -Fv "$RUN" | crontab -
  echo "✓ removed linkedin-sync cron ($RUN). Scheduled scraping is now OFF."
else
  echo "• no linkedin-sync cron found — nothing to remove."
fi
