/**
 * "Add a Substack post by address" for the editor.
 *
 * The site cannot rely on reading Substack (it answers Cloudflare's addresses with HTTP 429, intermittently), and a
 * browser cannot read it either (no CORS). So this tries once, server-side, and falls back gracefully:
 *   - Substack answers 200      -> full details (title, description, image, date) from the page's og: tags
 *   - Substack says 404         -> refuse: there is no such post
 *   - blocked / error / timeout -> list the post now with a title made from its address; the hourly pull (substack_sync.py)
 *                                  replaces it with the real details, because both use the same address as the key
 */
import { EXTERNAL_SOURCES } from "./sites.js";
import { upsertExternal } from "./db.js";

const POST_PATH = /^\/p\/([a-z0-9][a-z0-9-]{0,200})$/i;

/** @returns {{ id: string, src: object, url: string, slug: string }|null} null unless it is a post on one of our publications */
export function parsePostAddress(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const m = u.pathname.replace(/\/+$/, "").match(POST_PATH);
  if (!m) return null;
  for (const [id, src] of Object.entries(EXTERNAL_SOURCES)) {
    if (src.platform === "Substack" && src.host.test(u.hostname)) return { id, src, url: `https://${u.hostname}/p/${m[1]}`, slug: m[1] };
  }
  return null;
}

export const titleFromSlug = slug => {
  const t = slug.replace(/-+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const decode = s => String(s).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }[e]));

/** og: / article: meta tags of a post page. */
export function parseOg(html) {
  const get = prop => {
    const tag = (String(html).match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i")) || [])[0] || "";
    const v = (tag.match(/content=["']([^"']*)["']/i) || [])[1];
    return v ? decode(v).trim() : "";
  };
  return { title: get("og:title"), description: get("og:description"), image: get("og:image"), date: get("article:published_time") };
}

/** @returns {Promise<{status:number, body:object}>} */
export async function addByAddress(env, raw, fetcher = fetch, now = Math.floor(Date.now() / 1000)) {
  const p = parsePostAddress(raw);
  if (!p) return { status: 400, body: { error: "Paste the address of a post on vizneoacademy.substack.com or urbanlifeworks.substack.com (…/p/post-name)." } };

  let page = null;
  try {
    const res = await fetcher(p.url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; article-add)", Accept: "text/html" } });
    if (res.status === 404) return { status: 404, body: { error: "Substack has no post at that address." } };
    if (res.ok) page = parseOg(await res.text());
  } catch { /* blocked or unreachable: handled as provisional below */ }

  if (page && page.title) {
    const ts = Date.parse(page.date);
    const state = await upsertExternal(env.DB, p.src, {
      url: p.url, title: page.title.slice(0, 300), description: page.description.slice(0, 600),
      image: /^https:\/\//.test(page.image) ? page.image : null, published_at: Number.isFinite(ts) ? Math.floor(ts / 1000) : now,
    }, now);
    return { status: 200, body: { state: state === "inserted" ? "added" : "updated", title: page.title, source: p.src.source } };
  }

  const existing = await env.DB.prepare("SELECT title FROM articles WHERE external_url = ?").bind(p.url).first();
  if (existing) return { status: 200, body: { state: "exists", title: existing.title, source: p.src.source } };
  const title = titleFromSlug(p.slug);
  await upsertExternal(env.DB, p.src, { url: p.url, title, description: "", image: null, published_at: now }, now, 1);
  return { status: 200, body: { state: "queued", title, source: p.src.source,
    note: "Substack could not be read just now. It is listed with a title from its address; the next automatic pull (within 10 minutes) fills in the real title, description, image and date." } };
}
