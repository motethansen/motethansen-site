/**
 * GET /api/writing
 * Aggregates live Substack RSS feeds plus LinkedIn articles.
 *
 * All fetch/parse/merge/cache logic lives in shared/feed-core.js, which the
 * scheduled Worker (workers/feed-refresh/) imports too — see that file for the
 * per-source fallback model that keeps a single blocked publication from
 * silently vanishing from the feed.
 *
 * LinkedIn source:
 *   - Primary: KV key `linkedin-posts-v1` (a JSON array), maintained by the
 *     external DigitalOcean sync job in linkedin-sync/. Lets new LinkedIn
 *     articles appear with no redeploy.
 *   - Fallback: the in-repo seed array in content/linkedin-posts.js.
 *
 * Response: { posts, total, cached }
 *   - default: top 9 posts (homepage grid)
 *   - ?all=1 : the full merged list (the /writing/ articles page)
 *
 * Diagnostics: ?debug=1 forces a live rebuild (bypassing the merged cache) and
 * returns per-source status instead of posts. It never writes the merged cache,
 * so it is safe to hit while investigating a missing publication.
 */

import { buildFeed, cacheFeed, kvGetJson, CACHE_KEY } from "../../shared/feed-core.js";

const HOME_LIMIT = 9;

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const wantAll = params.get("all") === "1";

  if (params.get("debug") === "1") return debugResponse(env);

  // 1. Serve the cached full list if present.
  if (env.SITE_KV) {
    const cached = await kvGetJson(env, CACHE_KEY);
    if (Array.isArray(cached)) return feedResponse(cached, wantAll, true);
  }

  // 2. Rebuild from live sources (each with its own last-known-good fallback).
  const build = await buildFeed(env);

  // 3. Persist only a complete build — never cache a feed missing a publication.
  await cacheFeed(env, build);

  return feedResponse(build.posts, wantAll, false);
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

/** Live per-source status — no merged-cache read, no merged-cache write. */
async function debugResponse(env) {
  const build = await buildFeed(env);
  return jsonResponse({
    complete: build.complete,
    degraded: build.degraded,
    total: build.posts.length,
    sources: build.sources,
    byPlatform: build.posts.reduce((acc, p) => {
      const k = `${p.platform}/${p.source}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  });
}

function feedResponse(fullPosts, wantAll, cached) {
  const posts = wantAll ? fullPosts : fullPosts.slice(0, HOME_LIMIT);
  return jsonResponse({ posts, total: fullPosts.length, cached });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json",
               "Cache-Control": "public, max-age=3600", ...corsHeaders() },
  });
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}
