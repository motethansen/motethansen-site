/** HTTP glue for the /admin endpoints: JSON replies, cookies, same-origin check, auth guard. */
import { SESSION_COOKIE, SESSION_TTL_S, verifySession } from "./admin-core.js";

export const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extra },
});

export function readCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export const sessionCookie = token =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** State-changing requests must come from this site (belt and braces on top of SameSite=Strict). */
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}

/** @returns {Promise<{user:string}|Response>} the session, or a 401 Response to return as-is. */
export async function requireAdmin(request, env) {
  const s = await verifySession(env.ADMIN_SESSION_SECRET, readCookie(request, SESSION_COOKIE), Math.floor(Date.now() / 1000));
  return s ? { user: s.u } : json({ error: "Not signed in." }, 401);
}
