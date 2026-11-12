// Admin page: sign in, paste a LinkedIn article address, watch it go live. No dependencies, no innerHTML.
(() => {
  const $ = id => document.getElementById(id);
  const post = (path, body) => fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });

  function show(signedIn) {
    $("login").hidden = signedIn;
    $("add").hidden = !signedIn;
    (signedIn ? $("url") : $("user")).focus();
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

  const LABEL = {
    queued: "Queued. The server picks it up within a minute.",
    syncing: "Fetching the article…",
    published: "Published on the site.",
    live: "Already on the site.",
    failed: "Could not publish it.",
  };

  function render(li, rec) {
    li.className = rec.state;
    li.replaceChildren();
    const s = document.createElement("span");
    s.className = "state";
    s.textContent = LABEL[rec.state] || rec.state;
    li.append(s);
    const small = document.createElement("small");
    small.textContent = rec.title ? `${rec.title} · ${rec.url}` : rec.url;
    li.append(small);
    if (rec.reason) {
      const why = document.createElement("div");
      why.textContent = rec.reason;
      li.append(why);
    }
  }

  async function watch(li, id, url) {
    for (let i = 0; i < 90; i++) {                       // ~4.5 min at 3 s
      await new Promise(r => setTimeout(r, 3000));
      const r = await fetch(`/api/admin/status?id=${encodeURIComponent(id)}`, { credentials: "same-origin" });
      if (r.status === 401) { show(false); return; }
      if (!r.ok) continue;
      const rec = await r.json();
      render(li, rec);
      if (rec.state === "published" || rec.state === "failed") return;
    }
    render(li, { state: "failed", url, reason: "Still waiting after 4 minutes. Check again shortly; it may still publish." });
  }

  $("add").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("add-msg"), btn = $("save");
    msg.textContent = ""; msg.className = "msg";
    btn.disabled = true;
    try {
      const r = await post("/api/admin/add", { url: $("url").value });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { show(false); return; }
      if (!r.ok) { msg.textContent = d.error || "Could not save."; return; }
      const li = document.createElement("li");
      $("jobs").prepend(li);
      render(li, { state: d.state, url: d.url });
      $("url").value = "";
      if (d.id) watch(li, d.id, d.url);
    } catch {
      msg.textContent = "Network error. Try again.";
    } finally {
      btn.disabled = false;
    }
  });
})();
