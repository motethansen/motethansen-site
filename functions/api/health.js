/**
 * GET /api/health — Vantage component-health contract, Mode B (pull).
 *
 *   { "component": "motethansen-site", "status": "up|degraded", "ts": <epoch s>,
 *     "checks": { ... }, "errors": [ ... ] }
 *
 * Reads the status records the sync jobs and the /admin queue poller leave in KV; makes NO upstream request,
 * so polling it costs nothing and cannot worsen Substack's rate limiting.
 * See shared/health-core.js for the rules.
 */
import { kvGetJson } from "../../shared/feed-core.js";
import { computeHealth, FEED_STATUS_KEY, LINKEDIN_STATUS_KEY, POLLER_STATUS_KEY } from "../../shared/health-core.js";

/** The /admin queue: how many addresses are waiting and when the oldest was submitted. */
async function readQueue(env) {
  const [poller, listed] = await Promise.all([
    kvGetJson(env, POLLER_STATUS_KEY),
    env.SITE_KV.list({ prefix: "linkedin-pending:", limit: 20 }),
  ]);
  const times = (await Promise.all(listed.keys.map(k => kvGetJson(env, k.name))))
    .map(r => r && r.requestedAt).filter(Number.isFinite);
  return { poller, pending: listed.keys.length, oldestPendingS: times.length ? Math.min(...times) : null };
}

export async function onRequestGet({ env }) {
  const [feed, linkedin, queue] = await Promise.all([
    kvGetJson(env, FEED_STATUS_KEY),
    kvGetJson(env, LINKEDIN_STATUS_KEY),
    readQueue(env),
  ]);
  const body = computeHealth(feed, linkedin, Math.floor(Date.now() / 1000), queue);
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
