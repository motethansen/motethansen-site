/** GET /api/admin/me -> 200 {user} when signed in, else 401. The page uses it to choose login form or input box. */
import { json, requireAdmin } from "../../../shared/admin-http.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  return auth instanceof Response ? auth : json({ user: auth.user });
}
