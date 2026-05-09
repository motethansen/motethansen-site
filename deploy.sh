#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Deploying motethansen-site to Cloudflare Pages..."
wrangler pages deploy public --project-name motethansen-site --commit-dirty=true
echo "Done."
