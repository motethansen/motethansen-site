/**
 * GET /api/health — Vantage component-health contract, Mode B (pull).
 *
 *   { "component": "motethansen-site", "status": "up|degraded", "ts": <epoch s>, "checks": { ... }, "errors": [ ... ] }
 *
 * Reads the last-sync records the Substack pull leaves in KV and pings the articles service; makes no request to
 * Substack or any third party. See shared/health-core.js for the rules.
 */
import { computeHealth, SYNC_SOURCES, SYNC_PREFIX } from "../../shared/health-core.js";

export async function onRequestGet({ env }) {
  const syncs = Object.fromEntries(await Promise.all(
    SYNC_SOURCES.map(async (id) => [id, await env.SITE_KV.get(SYNC_PREFIX + id, "json")]),
  ));
  let serviceUp = false;
  try { serviceUp = (await env.ARTICLES.fetch("https://motethansen.com/writing/index.json")).ok; } catch { /* reported as down */ }
  return new Response(JSON.stringify(computeHealth(syncs, serviceUp, Math.floor(Date.now() / 1000))), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
