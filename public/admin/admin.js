// Admin shell: sign in / out, then hand over to the editor. No dependencies; HTML is only ever
// inserted from the server's sanitised Markdown preview, everything else uses textContent.
import { initEditor } from "./editor.js";

const $ = id => document.getElementById(id);

export async function api(path, { method = "GET", body, raw, type } = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (raw) { init.body = raw; init.headers["Content-Type"] = type; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.endsWith("/login") && !path.endsWith("/me")) show("login");
  return { ok: r.ok, status: r.status, data };
}

const views = ["login", "home", "editor"];
export function show(name) {
  for (const v of views) $(v).hidden = v !== name;
  if (name === "login") $("user").focus();
  if (name === "home") editor.refreshList();
}

const editor = initEditor({ api, show });

api("/api/admin/me").then(r => show(r.ok ? "home" : "login")).catch(() => show("login"));

$("login").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("login-msg");
  msg.textContent = "";
  const r = await api("/api/admin/login", { method: "POST", body: { username: $("user").value, password: $("pass").value } });
  if (r.ok) { $("pass").value = ""; show("home"); return; }
  msg.textContent = r.data.error || "Sign in failed.";
});

$("logout").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST" }); show("login"); });
