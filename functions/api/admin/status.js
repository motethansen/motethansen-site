/** GET /api/admin/status?id=<id> -> { state: queued | syncing | published | live | failed, ... } written by the droplet. */
import { json, requireAdmin } from "../../../shared/admin-http.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "Bad id." }, 400);
  const rec = await env.SITE_KV.get(`linkedin-add-status:${id}`, "json");
  return rec ? json(rec) : json({ error: "Unknown id." }, 404);
}
