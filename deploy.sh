#!/bin/bash
set -e
REPO="$(dirname "$0")"
cd "$REPO"

echo "▶ Deploying Pages site..."
wrangler pages deploy public --project-name motethansen-site --commit-dirty=true

echo ""
echo "▶ Deploying feed-refresh Worker..."
cd "$REPO/workers/feed-refresh"
wrangler deploy

echo ""
echo "✅ All done."
