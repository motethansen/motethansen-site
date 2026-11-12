/** POST /api/admin/logout -> clears the session cookie. */
import { json, sameOrigin, clearCookie } from "../../../shared/admin-http.js";

export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: "Bad origin." }, 403);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}
