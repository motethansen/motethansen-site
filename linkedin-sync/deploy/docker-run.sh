#!/usr/bin/env bash
#
# Scheduler entrypoint for the Dockerised LinkedIn -> Cloudflare KV sync.
# Invoked by the systemd timer (see enable-schedule.sh) or by hand.
# Any args pass through to linkedin_sync.py (e.g. --dry-run, --from-file …).
#
# Resolves its own location so it works under systemd's minimal environment,
# runs one container pass, and propagates the container's exit code so a failed
# scrape is visible to systemd (and shows up in `systemctl --failed`).
#
set -euo pipefail

# linkedin-sync/ dir (this script lives in linkedin-sync/deploy/).
HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$HERE"

# `docker compose` (v2 plugin) is required. Fail loudly if it's missing.
if ! docker compose version >/dev/null 2>&1; then
  echo "error: 'docker compose' not available — install the Docker Compose plugin" >&2
  exit 127
fi

# One-shot run; --rm cleans up the container. Exit code is the script's exit code.
exec docker compose run --rm sync "$@"
