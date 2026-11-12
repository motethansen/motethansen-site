/**
 * GET /api/health — Vantage component-health contract, Mode B (pull).
 *
 *   { "component": "motethansen-site", "status": "up|degraded", "ts": <epoch s>,
 *     "checks": { ... }, "errors": [ ... ] }
 *
 * Reads the two status records the sync jobs leave in KV; makes NO upstream request,
 * so polling it costs nothing and cannot worsen Substack's rate limiting.
 * See shared/health-core.js for the rules.
 */
import { kvGetJson } from "../../shared/feed-core.js";
import { computeHealth, FEED_STATUS_KEY, LINKEDIN_STATUS_KEY } from "../../shared/health-core.js";

export async function onRequestGet({ env }) {
  const [feed, linkedin] = await Promise.all([
    kvGetJson(env, FEED_STATUS_KEY),
    kvGetJson(env, LINKEDIN_STATUS_KEY),
  ]);
  const body = computeHealth(feed, linkedin, Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
