#!/bin/bash
set -e
REPO="$(dirname "$0")"
cd "$REPO"

# Unset any CF_ / CLOUDFLARE_ vars that .env might have loaded,
# so wrangler uses its own OAuth session instead.
unset CF_API_TOKEN CF_ACCOUNT_ID CF_EMAIL
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL

echo "▶ Deploying Pages site..."
wrangler pages deploy public --project-name motethansen-site --commit-dirty=true

echo ""
echo "▶ Deploying feed-refresh Worker..."
cd "$REPO/workers/feed-refresh"
wrangler deploy

echo ""
echo "✅ All done."
