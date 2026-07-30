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

# Rebuild the feed ON CLOUDFLARE, not here.
#
# This used to fetch the Substack feeds from the deploying machine, write the
# per-source snapshots, then delete the cache key. That made a laptop part of the
# production data path — and this machine is for development only. It also meant a
# deploy could only refresh content from a network that Substack happens to allow.
#
# Instead, ask the feed-refresh Worker to rebuild. It runs in Cloudflare with the
# same shared/feed-core.js logic the site uses, writes the snapshots itself on any
# successful fetch, and refuses to cache an incomplete build. No local fetching, no
# blind cache-bust to recover from.
#
# (Substack answers 200 to a residential IP, 403 to the droplet, and Cloudflare
# intermittently — so scripts/warm-feed-cache.mjs is retained as a MANUAL
# break-glass tool for the rare case where snapshots expire while Cloudflare is
# blocked. It is deliberately not part of any automated path.)
echo ""
echo "▶ Rebuilding the feed on Cloudflare..."
SECRET="$(sed -n 's/^FEED_REFRESH_SECRET=//p' .env | tail -1)"
if [ -z "$SECRET" ]; then
  echo "  ✘ FEED_REFRESH_SECRET missing from .env — cannot trigger the rebuild." >&2
  echo "    The hourly cron will pick the new code up within the hour." >&2
else
  curl -fsS "https://motethansen-feed-refresh.michaelhansen.workers.dev/refresh?secret=$SECRET" \
    | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const d=JSON.parse(s);
  for (const x of d.sources||[]) console.log(\`  \${x.id}: \${x.status} (\${x.count})\${x.error?' — '+x.error:''}\`);
  console.log(\`  cacheWritten=\${d.cacheWritten} count=\${d.count}\`);
});"
fi

echo ""
echo "▶ Verifying the live feed..."
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
