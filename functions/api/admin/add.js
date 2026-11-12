/**
 * POST /api/admin/add {url}
 *
 * Validates the LinkedIn article address and queues it for the droplet, which polls for
 * `linkedin-pending:*` keys every minute (linkedin-sync/admin_poll.py). A Pages Function cannot reach the
 * droplet and LinkedIn walls fetches from Cloudflare, so the droplet does the fetching; this only queues.
 * One key per request (no read-modify-write), so two quick submissions cannot overwrite each other.
 */
import { validateArticleUrl, slugOf } from "../../../shared/admin-core.js";
import { json, sameOrigin, requireAdmin } from "../../../shared/admin-http.js";
import { LINKEDIN_KEY } from "../../../shared/feed-core.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Bad origin." }, 403);
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  let url;
  try {
    url = validateArticleUrl((await request.json()).url);
  } catch (e) {
    return json({ error: e.message || "Bad request." }, 400);
  }

  const known = (await env.SITE_KV.get(LINKEDIN_KEY, "json")) || [];
  if (known.some(p => slugOf(p.url || "") === slugOf(url))) {
    return json({ id: null, state: "live", url, message: "That article is already on the site." });
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.SITE_KV.put(`linkedin-pending:${id}`, JSON.stringify({ url, requestedAt: now }), { expirationTtl: 86400 });
  await env.SITE_KV.put(`linkedin-add-status:${id}`, JSON.stringify({ state: "queued", url, ts: now }), { expirationTtl: 7 * 86400 });
  return json({ id, state: "queued", url });
}
