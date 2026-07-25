#!/usr/bin/env bash
#
# Stop scheduled scraping: disable + remove the systemd timer/service installed
# by enable-schedule.sh. Safe to run whether or not the timer is installed.
# Re-enable later with:  sudo bash deploy/enable-schedule.sh
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo (removes unit files from /etc/systemd/system)" >&2
  exit 1
fi

DEST="/etc/systemd/system"
UNIT="linkedin-sync-docker"

if systemctl list-unit-files "$UNIT.timer" >/dev/null 2>&1; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
fi

rm -f "$DEST/$UNIT.timer" "$DEST/$UNIT.service"
rm -rf "$DEST/$UNIT.service.d"
systemctl daemon-reload

echo "✓ removed $UNIT timer + service. Scheduled scraping is now OFF."
