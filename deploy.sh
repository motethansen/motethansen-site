#!/bin/bash
set -e
# Absolute — later steps cd into workers/ and back, so a relative "." silently
# leaves us in the wrong directory.
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

# Unset any CF_ / CLOUDFLARE_ vars that .env might have loaded,
# so wrangler uses its own OAuth session instead.
unset CF_API_TOKEN CF_ACCOUNT_ID CF_EMAIL
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL

# The Wrangler OAuth session has access to multiple Cloudflare accounts, so
# non-interactive `wrangler` commands can't auto-select one. Pin it to the
# account this site lives in (same as workers/articles/wrangler.toml).
export CLOUDFLARE_ACCOUNT_ID=f999794776f99de37612b4abbfbfc21a

echo "▶ Deploying the articles service (D1 schema + Worker)..."
cd "$REPO/workers/articles"
npm ci --silent
wrangler d1 migrations apply motethansen-articles --remote
wrangler deploy
cd "$REPO"

echo ""
echo "▶ Deploying Pages site..."
wrangler pages deploy public --project-name motethansen-site --commit-dirty=true

echo ""
echo "▶ Verifying the live site..."
sleep 3
curl -fsS -A "Mozilla/5.0 (compatible; deploy-check)" "https://motethansen.com/api/writing?all=1" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const d=JSON.parse(s); const by={};
  for (const p of d.posts) by[p.platform+' / '+p.source]=(by[p.platform+' / '+p.source]||0)+1;
  console.log('  total:', d.total, JSON.stringify(by));
  if (!d.total) { console.error('\\n❌ The site lists no articles.'); process.exit(1); }
});"
curl -fsS -A "Mozilla/5.0 (compatible; deploy-check)" "https://motethansen.com/api/health" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log('  health:', d.status, d.errors.join('; ')||'');});"

echo ""
echo "✅ All done."
