#!/usr/bin/env bash
#
# Install + start the 1-minute poller behind motethansen.com/admin (admin_poll.py).
# Idempotent. Must run as root. Undo: systemctl disable --now linkedin-admin-poll.timer
#
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "error: run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"   # linkedin-sync/
DEST="/etc/systemd/system"
UNIT="linkedin-admin-poll"

cp "$HERE/deploy/systemd/$UNIT.service" "$DEST/$UNIT.service"
cp "$HERE/deploy/systemd/$UNIT.timer"   "$DEST/$UNIT.timer"
mkdir -p "$DEST/$UNIT.service.d"
cat > "$DEST/$UNIT.service.d/10-path.conf" <<CONF
[Service]
WorkingDirectory=$HERE
ExecStart=
ExecStart=/usr/bin/python3 $HERE/admin_poll.py
CONF

systemctl daemon-reload
systemctl enable --now "$UNIT.timer"
echo "✓ $UNIT.timer is on (every 60 s). logs: journalctl -u $UNIT.service -n 30 --no-pager"
