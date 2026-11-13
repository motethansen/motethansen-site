// Article list and Markdown editor.
import { htmlToMarkdown, importableImages } from "./html2md.js";

const YOUTUBE_URL = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/;

const $ = id => document.getElementById(id);

const slugify = t => t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/, "");

const pad = n => String(n).padStart(2, "0");
const toLocalInput = ts => { if (!ts) return ""; const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = v => (v ? Math.floor(new Date(v).getTime() / 1000) : null);
const fmtDate = ts => (ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "no date");

export function initEditor({ api, show }) {
  let current = null;          // the saved article, or null for a new one
  let dirty = false;
  let slugTouched = false;
  let filter = "";
  let previewTimer = null;
  let siteNames = [];          // enabled sites from the server
  let currentSite = null;      // the site this admin page is open on (default for new articles)

  const say = (id, text, ok = false) => { const e = $(id); e.textContent = text; e.className = "msg" + (ok ? " ok" : ""); };

  // ---------- sites ----------
  async function loadConfig() {
    const r = await api("/api/admin/config");
    if (!r.ok) return;
    siteNames = r.data.sites; currentSite = r.data.current;
    const box = $("sites");
    box.querySelectorAll("label").forEach(l => l.remove());
    for (const name of siteNames) {
      const label = document.createElement("label");
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", value: name });
      cb.addEventListener("change", () => setDirty(true));
      label.append(cb, document.createTextNode(name === "vizneo" ? "vizneo.com" : "motethansen.com"));
      box.append(label);
    }
  }
  const setSites = list => document.querySelectorAll("#sites input").forEach(cb => { cb.checked = list.includes(cb.value); });
  const getSites = () => [...document.querySelectorAll("#sites input:checked")].map(cb => cb.value);

  // ---------- list ----------
  async function refreshList() {
    say("list-msg", "");
    const r = await api("/api/admin/articles" + (filter ? `?status=${filter}` : ""));
    const ul = $("list");
    ul.replaceChildren();
    if (!r.ok) { say("list-msg", r.data.error || "Could not load articles."); return; }
    if (!r.data.articles.length) {
      const li = document.createElement("li");
      li.textContent = "Nothing here yet. Press “New article”.";
      ul.append(li);
      return;
    }
    for (const a of r.data.articles) {
      const li = document.createElement("li");
      const t = Object.assign(document.createElement("span"), { className: "t", textContent: a.title });
      const chip = Object.assign(document.createElement("span"), { className: "chip " + a.status, textContent: a.status });
      const sites = Object.assign(document.createElement("span"), { className: "s", textContent: a.sites.join(", ") });
      const d = Object.assign(document.createElement("span"), { className: "d", textContent: fmtDate(a.published_at || a.created_at) });
      li.append(t, sites, chip, d);
      li.addEventListener("click", () => openArticle(a.id));
      ul.append(li);
    }
  }

  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
    filter = b.dataset.status;
    refreshList();
  }));

  // ---------- add a Substack post by address ----------
  $("ext").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("ext").querySelector("button"); btn.disabled = true;
    say("ext-msg", "");
    try {
      const r = await api("/api/admin/external", { method: "POST", body: { url: $("ext-url").value } });
      if (!r.ok) { say("ext-msg", r.data.error || "Could not add that post."); return; }
      const d = r.data;
      say("ext-msg", d.state === "queued" ? `Added “${d.title}”. ${d.note}`
        : d.state === "exists" ? `Already listed: “${d.title}”.` : `${d.state === "added" ? "Added" : "Updated"} “${d.title}” (${d.source}). It is on the site now.`, true);
      $("ext-url").value = "";
    } finally { btn.disabled = false; }
  });

  // ---------- editor state ----------
  function fill(a) {
    current = a && a.id ? a : null;
    const v = a || {};
    $("f-title").value = v.title || "";
    $("f-slug").value = v.slug || "";
    $("f-date").value = toLocalInput(v.published_at);
    $("f-desc").value = v.description || "";
    $("f-tags").value = (v.tags || []).join(", ");
    $("f-cover").value = v.cover || "";
    $("f-body").value = v.body_md || "";
    $("f-origin").value = v.origin_url || "";
    setSites(v.sites || (currentSite ? [currentSite] : []));
    slugTouched = !!current;
    setDirty(false);
    syncChrome();
    renderPreview();
  }

  function syncChrome() {
    const published = current && current.status === "published";
    const chip = $("state");
    chip.textContent = current ? current.status : "new";
    chip.className = "chip " + (current ? current.status : "");
    $("publish").textContent = published ? "Update" : "Publish";
    $("save").textContent = published ? "Unpublish" : "Save draft";
    $("save").dataset.mode = published ? "unpublish" : "save";
    $("delete").hidden = !current;
    const view = $("view");
    view.hidden = !published;
    if (published) view.href = `/writing/${current.slug}/`;
    $("slug-url").textContent = "/writing/" + ($("f-slug").value || "…") + "/";
    const cover = $("f-cover").value.trim();
    const img = $("cover-img");
    img.hidden = !cover;
    if (cover) img.src = cover;
    $("pv-title").textContent = $("f-title").value;
  }

  function setDirty(v) { dirty = v; $("state").title = v ? "Unsaved changes" : ""; document.title = (v ? "• " : "") + "Admin"; }
  window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  function collect() {
    return {
      title: $("f-title").value, slug: $("f-slug").value.trim(), description: $("f-desc").value,
      tags: $("f-tags").value.split(","), cover: $("f-cover").value.trim(), body_md: $("f-body").value,
      published_at: fromLocalInput($("f-date").value), origin_url: $("f-origin").value.trim(), sites: getSites(),
    };
  }

  for (const id of ["f-title", "f-slug", "f-date", "f-desc", "f-tags", "f-cover", "f-body", "f-origin"]) {
    $(id).addEventListener("input", () => {
      setDirty(true);
      if (id === "f-title" && !slugTouched) $("f-slug").value = slugify($("f-title").value);
      if (id === "f-slug") slugTouched = true;
      syncChrome();
      if (id === "f-body") { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }
    });
  }

  async function renderPreview() {
    const r = await api("/api/admin/preview", { method: "POST", body: { body_md: $("f-body").value } });
    if (r.ok) $("preview").innerHTML = r.data.html;          // server-side sanitised (raw HTML escaped, unsafe URLs dropped)
  }

  // ---------- open / new / back ----------
  async function openArticle(id) {
    const r = await api(`/api/admin/articles/${id}`);
    if (!r.ok) { say("list-msg", r.data.error || "Could not open that article."); return; }
    say("ed-msg", "");
    fill(r.data);
    show("editor");
  }
  $("new").addEventListener("click", () => { say("ed-msg", ""); fill(null); show("editor"); $("f-title").focus(); });
  $("back").addEventListener("click", () => { if (!dirty || confirm("Leave without saving your changes?")) { setDirty(false); show("home"); } });

  // ---------- save / publish / delete ----------
  // One server action at a time: a second click while one is running would create a duplicate article.
  let busy = false;
  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    const btns = ["save", "publish", "delete"].map($);
    btns.forEach(b => { b.disabled = true; });
    say("ed-msg", "");
    try { return await fn(); } finally { busy = false; btns.forEach(b => { b.disabled = false; }); }
  }

  async function save() {
    const r = current
      ? await api(`/api/admin/articles/${current.id}`, { method: "PUT", body: collect() })
      : await api("/api/admin/articles", { method: "POST", body: collect() });
    if (!r.ok) { say("ed-msg", r.data.error || "Could not save."); return null; }
    fill(r.data);
    return r.data;
  }

  $("save").addEventListener("click", () => withBusy(async () => {
    if ($("save").dataset.mode === "unpublish") {
      const a = await save();
      if (!a) return;
      const r = await api(`/api/admin/articles/${a.id}/unpublish`, { method: "POST" });
      if (r.ok) { fill(r.data); say("ed-msg", "Unpublished. It is now a draft.", true); } else say("ed-msg", r.data.error || "Could not unpublish.");
    } else if (await save()) {
      say("ed-msg", "Draft saved.", true);
    }
  }));

  $("publish").addEventListener("click", () => withBusy(async () => {
    const a = await save();
    if (!a) return;
    const r = await api(`/api/admin/articles/${a.id}/publish`, { method: "POST" });
    if (!r.ok) { say("ed-msg", r.data.error || "Could not publish."); return; }
    fill(r.data);
    say("ed-msg", "Published. It is live at " + location.origin + "/writing/" + r.data.slug + "/", true);
  }));

  $("delete").addEventListener("click", () => withBusy(async () => {
    if (!current || !confirm(`Delete “${current.title}” for good? This cannot be undone.`)) return;
    const r = await api(`/api/admin/articles/${current.id}`, { method: "DELETE" });
    if (r.ok) { setDirty(false); show("home"); } else say("ed-msg", r.data.error || "Could not delete.");
  }));

  document.addEventListener("keydown", e => {
    if ($("editor").hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); $("save").dataset.mode === "unpublish" ? $("publish").click() : $("save").click(); }
  });

  // ---------- Markdown toolbar ----------
  const ta = $("f-body");
  function wrap(before, after, placeholder) {
    const [s, e] = [ta.selectionStart, ta.selectionEnd];
    const sel = ta.value.slice(s, e) || placeholder;
    ta.setRangeText(before + sel + after, s, e, "end");
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    ta.focus(); ta.dispatchEvent(new Event("input"));
  }
  function linePrefix(prefix) {
    const s = ta.selectionStart;
    const start = ta.value.lastIndexOf("\n", s - 1) + 1;
    ta.setRangeText(prefix, start, start, "end");
    ta.focus(); ta.dispatchEvent(new Event("input"));
  }
  const FMT = {
    bold: () => wrap("**", "**", "bold text"), italic: () => wrap("_", "_", "italic text"),
    h2: () => linePrefix("## "), h3: () => linePrefix("### "), quote: () => linePrefix("> "), list: () => linePrefix("- "),
    code: () => wrap("`", "`", "code"),
    link: () => { const url = prompt("Link address (https://…)"); if (url) wrap("[", `](${url})`, "link text"); },
    image: () => { pendingInsert = true; $("file").click(); },
    video: () => {
      const url = (prompt("YouTube address (https://www.youtube.com/watch?v=… or https://youtu.be/…)") || "").trim();
      if (!url) return;
      if (!YOUTUBE_URL.test(url)) { say("ed-msg", "That does not look like a YouTube video address."); return; }
      const s = ta.selectionStart;
      ta.setRangeText(`\n\n${url}\n\n`, s, ta.selectionEnd, "end");     // a line of its own is what makes it a player
      ta.focus(); ta.dispatchEvent(new Event("input"));
      say("ed-msg", "Video added. It plays in the preview and on the published page.", true);
    },
  };
  document.querySelectorAll(".toolbar [data-fmt]").forEach(b => b.addEventListener("click", () => FMT[b.dataset.fmt]()));
  ta.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); FMT.bold(); } else if (k === "i") { e.preventDefault(); FMT.italic(); } else if (k === "k") { e.preventDefault(); FMT.link(); }
  });

  // ---------- images ----------
  let pendingInsert = false;
  async function upload(file) {
    if (!file) return null;
    const r = await api("/api/admin/media", { method: "POST", raw: file, type: file.type });
    if (!r.ok) { say("ed-msg", r.data.error || "Upload failed."); return null; }
    say("ed-msg", "Image uploaded.", true);
    return r.data.url;
  }
  $("file").addEventListener("change", async () => {
    const file = $("file").files[0];
    $("file").value = "";
    const url = await upload(file);
    if (!url) { pendingInsert = false; return; }
    if (pendingInsert) { wrap("![", `](${url})`, file.name.replace(/\.[^.]+$/, "")); }
    else { $("f-cover").value = url; $("f-cover").dispatchEvent(new Event("input")); }
    pendingInsert = false;
  });
  $("cover-up").addEventListener("click", () => { pendingInsert = false; $("file").click(); });
  $("cover-clear").addEventListener("click", () => { $("f-cover").value = ""; $("f-cover").dispatchEvent(new Event("input")); });
  // Ctrl/Cmd+Shift+V pastes plain text as-is; a normal paste of a web page becomes Markdown.
  let plainPaste = false;
  ta.addEventListener("keydown", e => { plainPaste = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v"; });

  function insertAtCaret(text) {
    const s = ta.selectionStart;
    ta.setRangeText(text, s, ta.selectionEnd, "end");
    ta.focus(); ta.dispatchEvent(new Event("input"));
    return [s, s + text.length];
  }

  async function importImages(urls) {
    let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      say("ed-msg", `Copying image ${i + 1} of ${urls.length} into your own storage…`, true);
      const r = await api("/api/admin/media/import", { method: "POST", body: { url: urls[i] } });
      if (r.ok) ta.value = ta.value.split(urls[i]).join(r.data.url);
      else failed++;
    }
    ta.dispatchEvent(new Event("input"));
    say("ed-msg", failed
      ? `${urls.length - failed} image(s) copied; ${failed} could not be and still point at the original site.`
      : `Pasted. ${urls.length} image(s) copied into your own storage.`, !failed);
  }

  ta.addEventListener("paste", async e => {
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      const url = await upload(file);
      if (url) wrap("![", `](${url})`, "image");
      return;
    }
    const html = e.clipboardData?.getData("text/html");
    if (!html || plainPaste) return;                       // plain text: let the browser paste it
    e.preventDefault();
    const md = htmlToMarkdown(html);
    insertAtCaret(md);
    const urls = importableImages(md);
    if (urls.length) await importImages(urls);
    else say("ed-msg", "Pasted as Markdown. Check the preview.", true);
  });

  loadConfig();
  return { refreshList };
}
