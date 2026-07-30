#!/usr/bin/env bash
#
# Go-live: install + start the systemd timer that runs the Dockerised sync twice
# daily (05:30 + 17:30 UTC, +/-15min jitter — see the .timer unit). The schedule is
# OPT-IN: nothing runs on a timer until you run this. Undo with disable-schedule.sh.
#
# Idempotent: safe to re-run (e.g. after `git pull`). Must run as root (sudo).
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (installs unit files into /etc/systemd/system)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"   # linkedin-sync/
SRC="$HERE/deploy/systemd"
DEST="/etc/systemd/system"
UNIT="linkedin-sync-docker"

cp "$SRC/$UNIT.service" "$DEST/$UNIT.service"
cp "$SRC/$UNIT.timer"   "$DEST/$UNIT.timer"

# Pin the unit to THIS checkout's real path via a drop-in, so the shipped
# absolute-path defaults don't have to be correct for every droplet.
mkdir -p "$DEST/$UNIT.service.d"
cat > "$DEST/$UNIT.service.d/10-path.conf" <<EOF
[Service]
WorkingDirectory=$HERE
ExecStart=
ExecStart=$HERE/deploy/docker-run.sh
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.timer"

echo "✓ scheduled: $UNIT.timer (05:30 + 17:30 UTC). Sync is now ON."
echo "  next run:  systemctl list-timers $UNIT.timer"
echo "  run now:   sudo systemctl start $UNIT.service"
echo "  logs:      journalctl -u $UNIT.service -n 50 --no-pager"
echo "  stop:      bash deploy/disable-schedule.sh"
