/**
 * motethansen-feed-refresh Worker
 *
 * Scheduled cron: rebuilds the merged writing feed (Substack RSS + LinkedIn)
 * and writes it to KV so the website always has fresh content.
 *
 * Crons (wrangler.toml):
 *   "0 20 * * *"  — daily at 20:00 UTC
 *
 * Also handles GET /refresh for manual triggers (protected by REFRESH_SECRET).
 *
 * All fetch/parse/merge/cache logic lives in shared/feed-core.js, shared with
 * the Pages Function (functions/api/writing.js). In particular the cache is
 * only overwritten when the rebuild is COMPLETE — every source contributed
 * posts, whether fetched live or restored from its own last-known-good
 * snapshot. A build missing a publication is returned to the caller but never
 * persisted.
 */

import { buildFeed, cacheFeed, CACHE_KEY } from "../../shared/feed-core.js";

export default {
  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFeeds(env));
  },

  // HTTP handler — GET /refresh?secret=xxx for manual trigger
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/refresh") {
      return new Response("motethansen feed-refresh worker\n", { status: 200 });
    }

    // Fail CLOSED. This previously only checked the secret when one happened to
    // be configured — and none was, so /refresh was a public endpoint that any
    // caller could use to drive outbound fetches and KV writes.
    const secret = env.REFRESH_SECRET;
    if (!secret || url.searchParams.get("secret") !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const { build, wrote } = await refreshFeeds(env);
      return new Response(
        JSON.stringify({
          ok: true,
          complete: build.complete,
          degraded: build.degraded,
          cacheWritten: wrote,
          count: build.posts.length,
          sources: build.sources,
          posts: url.searchParams.get("verbose") === "1" ? build.posts : undefined,
        }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

async function refreshFeeds(env) {
  console.log("[feed-refresh] Starting rebuild");

  const build = await buildFeed(env);
  for (const s of build.sources) {
    console.log(`[feed-refresh] ${s.id}: ${s.status} (${s.count} posts)${s.error ? ` — ${s.error}` : ""}`);
  }

  const wrote = await cacheFeed(env, build);
  if (wrote) {
    console.log(`[feed-refresh] Wrote ${build.posts.length} posts to KV key "${CACHE_KEY}"` +
                (build.degraded ? " (degraded build — short TTL)" : ""));
  } else {
    console.warn("[feed-refresh] Incomplete build — skipping cache write to avoid dropping a publication");
  }

  return { build, wrote };
}
