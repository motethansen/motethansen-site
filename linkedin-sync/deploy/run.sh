#!/usr/bin/env bash
#
# Cron/systemd entrypoint for the LinkedIn -> Cloudflare KV sync.
# Resolves its own location so it works under cron's minimal environment.
# Any args are passed through to linkedin_sync.py (e.g. --dry-run, --from-file …).
#
set -euo pipefail

# linkedin-sync/ dir (this script lives in linkedin-sync/deploy/)
HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$HERE"

PYTHON="$HERE/.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"

# Log somewhere writable: /var/log if possible, else next to the script.
LOG="${LINKEDIN_SYNC_LOG:-/var/log/linkedin-sync.log}"
if ! touch "$LOG" 2>/dev/null; then
  LOG="$HERE/linkedin-sync.log"
fi

{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) linkedin-sync ====="
  "$PYTHON" "$HERE/linkedin_sync.py" "$@"
  echo "===== done (exit $?) ====="
} >> "$LOG" 2>&1
