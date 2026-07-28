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
# account this site lives in (same as workers/feed-refresh/wrangler.toml).
export CLOUDFLARE_ACCOUNT_ID=f999794776f99de37612b4abbfbfc21a

echo "▶ Deploying Pages site..."
wrangler pages deploy public --project-name motethansen-site --commit-dirty=true

echo ""
echo "▶ Deploying feed-refresh Worker..."
cd "$REPO/workers/feed-refresh"
wrangler deploy

cd "$REPO"

# Warm the per-source snapshots BEFORE busting the merged cache. Substack
# blocks Cloudflare egress at times, so a rebuild triggered by the bust can
# fail to fetch a publication that this machine fetches fine — the snapshots
# are what keep that publication in the feed instead of silently dropping it.
# If this fails, stop: busting the cache without warm snapshots is how the
# feed loses a publication for hours.
echo ""
echo "▶ Warming per-source feed snapshots..."
node scripts/warm-feed-cache.mjs

echo ""
echo "▶ Busting writing feed cache..."
wrangler kv key delete "writing-feed-v4" --namespace-id=1b97cac1e10d4bcaaa1bef301a86af26 --remote
# Old key from before the full-list cache format — clean up if still present.
wrangler kv key delete "writing-feed-v3" --namespace-id=1b97cac1e10d4bcaaa1bef301a86af26 --remote 2>/dev/null || true

echo ""
echo "▶ Verifying the rebuilt feed..."
sleep 3
curl -fsS "https://motethansen.com/api/writing?debug=1" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const d=JSON.parse(s);
  for (const x of d.sources) console.log(\`  \${x.id}: \${x.status} (\${x.count})\${x.error?' — '+x.error:''}\`);
  console.log('  byPlatform:', JSON.stringify(d.byPlatform));
  if (!d.complete) { console.error('\n❌ Feed is INCOMPLETE — a publication is missing. Not safe to leave as is.'); process.exit(1); }
  if (d.degraded) console.log('\n⚠️  Complete, but a source came from its snapshot (Substack blocked Cloudflare).');
});"

echo ""
echo "✅ All done."
