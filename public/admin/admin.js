// Admin page: sign in / sign out. The article editor mounts into #home. No dependencies, no innerHTML.
(() => {
  const $ = id => document.getElementById(id);
  const post = (path, body) => fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });

  function show(signedIn) {
    $("login").hidden = signedIn;
    $("home").hidden = !signedIn;
    if (!signedIn) $("user").focus();
  }

  fetch("/api/admin/me", { credentials: "same-origin" }).then(r => show(r.ok)).catch(() => show(false));

  $("login").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("login-msg");
    msg.textContent = "";
    const r = await post("/api/admin/login", { username: $("user").value, password: $("pass").value });
    if (r.ok) { $("pass").value = ""; show(true); return; }
    const d = await r.json().catch(() => ({}));
    msg.textContent = d.error || "Sign in failed.";
  });

  $("logout").addEventListener("click", async () => { await post("/api/admin/logout"); show(false); });
})();
