/** POST /api/admin/login {username, password} -> sets the session cookie. */
import { checkCredentials, signSession, throttleState, recordFailure, THROTTLE_WINDOW_S } from "../../../shared/admin-core.js";
import { json, sameOrigin, sessionCookie } from "../../../shared/admin-http.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "Bad origin." }, 403);
  if (!env.ADMIN_SESSION_SECRET || !env.ADMIN_USER || !env.ADMIN_PASSWORD) {
    return json({ error: "Admin is not configured." }, 503);
  }
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `admin-throttle:${ip}`;
  const state = throttleState(await env.SITE_KV.get(key, "json"), now);
  if (state.locked) {
    return json({ error: "Too many attempts. Try again later." }, 429, { "Retry-After": String(state.retryAfterS) });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  if (!(await checkCredentials(env, body.username, body.password))) {
    await env.SITE_KV.put(key, JSON.stringify(recordFailure(state.record, now)), { expirationTtl: THROTTLE_WINDOW_S });
    return json({ error: "Wrong username or password." }, 401);
  }
  await env.SITE_KV.delete(key);
  const token = await signSession(env.ADMIN_SESSION_SECRET, body.username, now);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}
