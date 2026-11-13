/**
 * GET /api/health — Vantage component-health contract, Mode B (pull).
 *
 *   { "component": "motethansen-site", "status": "up|degraded", "ts": <epoch s>, "checks": { ... }, "errors": [ ... ] }
 *
 * Reads the status record the hourly feed-refresh Worker leaves in KV; makes NO upstream request, so polling it
 * costs nothing and cannot worsen Substack's rate limiting. See shared/health-core.js for the rules.
 */
import { kvGetJson } from "../../shared/feed-core.js";
import { computeHealth, FEED_STATUS_KEY } from "../../shared/health-core.js";

export async function onRequestGet({ env }) {
  const feed = await kvGetJson(env, FEED_STATUS_KEY);
  return new Response(JSON.stringify(computeHealth(feed, Math.floor(Date.now() / 1000))), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
