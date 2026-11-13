/**
 * motethansen-articles: shared article service for motethansen.com (and vizneo.com next).
 * Reached only through service bindings from the sites (workers_dev is off), so request URLs keep the
 * visitor's host. Routes:
 *   /api/admin/*            sign-in + article CRUD + preview + image upload   (session cookie required)
 *   /writing/<slug>/        public article page          /writing/rss.xml    /writing/index.json
 *   /media/<yyyy>/<mm>/<id>.<ext>   uploaded images from R2
 */
import { login, logout, me } from "./auth.js";
import { json, sameOrigin, requireAdmin } from "../../../shared/admin-http.js";
import * as store from "./db.js";
import { renderMarkdown, excerpt, firstImage, clip } from "./render.js";
import { validateArticle, validateIngest } from "./validate.js";
import { uploadImage, importImage, serveImage } from "./media.js";
import { addByAddress } from "./substack.js";
import { articlePage, feedEntry, rssFeed, listPage } from "./templates.js";
import { siteOf, ENABLED_SITES } from "./sites.js";
import { timingSafeEqualStr } from "../../../shared/admin-core.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const html = (body, status = 200, extra = {}) => new Response(body, {
  status, headers: { "Content-Type": "text/html; charset=utf-8", ...extra },
});

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("[articles]", e?.stack || e);
      return json({ error: "Server error." }, 500);
    }
  },
};

export async function route(request, env, deps = {}) {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const method = request.method;

  if (path === "/api/ingest/external") return ingest(request, env, method);
  if (path.startsWith("/api/admin/")) return admin(request, env, path.slice("/api/admin/".length), method, deps);
  if (path === "/admin") return Response.redirect(new URL("/admin/", request.url).toString(), 308);
  if (path.startsWith("/admin/")) return adminUi(request, env);

  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (path.startsWith("/media/")) return serveImage(env, path, method);

  const site = siteOf(request);
  if (!ENABLED_SITES.includes(site)) return new Response("Not found", { status: 404 });

  if (path === "/writing/index.json") {
    const list = await store.listArticles(env.DB, { status: "published", site, limit: 500 });
    return new Response(JSON.stringify({ articles: list.map(a => feedEntry(site, a)) }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" },
    });
  }
  if (path === "/writing/rss.xml") {
    const list = (await store.listArticles(env.DB, { status: "published", site, limit: 30, external: false }));
    const full = await Promise.all(list.map(a => store.getById(env.DB, a.id)));
    return new Response(rssFeed(site, full, full.map(a => renderMarkdown(a.body_md, { embeds: false }))), {
      headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }
  if (path === "/writing" || path === "/writing/") {
    // motethansen.com keeps its static archive page (its Pages function never forwards this path); other sites render it here.
    const list = await store.listArticles(env.DB, { status: "published", site, limit: 500 });
    return html(listPage(site, await toCards(env, list)), 200, { "Cache-Control": "public, max-age=60, s-maxage=120" });
  }
  const m = path.match(/^\/writing\/([a-z0-9][a-z0-9-]{1,98}[a-z0-9])\/?$/);
  if (m) {
    const a = await store.getPublishedBySlug(env.DB, m[1], site);
    if (!a) return new Response("Not found", { status: 404 });
    return html(articlePage(site, a, renderMarkdown(a.body_md)), 200, { "Cache-Control": "public, max-age=60, s-maxage=120" });
  }
  return new Response("Not found", { status: 404 });
}

/**
 * What each card on the archive shows. Linked-out entries carry their own cover and description. For an article written
 * here, the cover is its cover image or else the first picture in its text, and a missing description becomes the
 * opening words of the text, so every card has something to read.
 */
async function toCards(env, list) {
  return Promise.all(list.map(async a => {
    if (a.external_url) return { a, image: a.cover || null, brief: clip(a.description) };
    const full = (!a.cover || !a.description) ? await store.getById(env.DB, a.id) : null;
    return {
      a,
      image: a.cover || firstImage(full?.body_md),
      brief: clip(a.description || excerpt(full?.body_md || "", 240)),
    };
  }));
}

/** The editor page and its scripts, served from this Worker's own assets so every site shares one copy. */
const ADMIN_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https:; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
};
async function adminUi(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) out.headers.set(k, v);
  return out;
}

/**
 * POST /api/ingest/external  (Authorization: Bearer <INGEST_TOKEN>)
 * { source: "va-substack", entries: [{ url, title, date, description, image }] } — pushed hourly by the mac-mini, which can
 * read Substack when Cloudflare cannot (Substack answers Cloudflare's IPs with HTTP 429). Upserts by address; never deletes.
 */
async function ingest(request, env, method) {
  if (method !== "POST") return json({ error: "Method not allowed." }, 405);
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.INGEST_TOKEN || !given || !(await timingSafeEqualStr(given, env.INGEST_TOKEN))) return json({ error: "Not authorised." }, 401);
  const body = await readJson(request);
  const v = validateIngest(body);
  if (!v.src) return json({ error: v.errors[0] }, 400);
  let inserted = 0, updated = 0;
  for (const e of v.entries) (await store.upsertExternal(env.DB, v.src, e)) === "inserted" ? inserted++ : updated++;
  const now = Math.floor(Date.now() / 1000);
  // a pull lists the publication's whole catalogue, so a provisional entry it never sees is a mistyped address
  const removed = await store.removeUnconfirmed(env.DB, v.src.source, v.entries.map(e => e.url), now);
  // what /api/health reads: when this source last synced, and what it saw
  await env.SITE_KV.put(`external-sync-v1:${body.source}`, JSON.stringify({ ts: now, seen: v.entries.length, inserted, updated, skipped: v.errors.length }), { expirationTtl: 7 * 86400 });
  return json({ ok: true, inserted, updated, removed, skipped: v.errors });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function admin(request, env, sub, method, deps = {}) {
  if (sub === "login" && method === "POST") return login({ request, env });
  if (sub === "logout" && method === "POST") return logout({ request, env });
  if (sub === "me" && method === "GET") return me({ request, env });

  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (method !== "GET" && !sameOrigin(request)) return json({ error: "Bad origin." }, 403);

  if (sub === "config" && method === "GET") return json({ sites: ENABLED_SITES, current: siteOf(request) });

  if (sub === "articles" && method === "GET") {
    const u = new URL(request.url);
    const status = ["draft", "published"].includes(u.searchParams.get("status")) ? u.searchParams.get("status") : null;
    return json({ articles: await store.listArticles(env.DB, { status, q: u.searchParams.get("q") || null, external: false }) });
  }
  if (sub === "articles" && method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "Bad request." }, 400);
    const { value, errors } = validateArticle({ sites: [siteOf(request)], ...body });
    if (errors.length) return json({ error: errors[0], errors }, 400);
    try {
      return json(await store.createArticle(env.DB, value), 201);
    } catch (e) {
      if (store.isUniqueViolation(e)) return json({ error: "Another article already uses that address (slug)." }, 409);
      throw e;
    }
  }

  const one = sub.match(new RegExp(`^articles/(${UUID})(?:/(publish|unpublish))?$`));
  if (one) {
    const [, id, action] = one;
    if (!action && method === "GET") {
      const a = await store.getById(env.DB, id);
      return a ? json(a) : json({ error: "Not found." }, 404);
    }
    if (!action && method === "PUT") {
      const existing = await store.getById(env.DB, id);
      if (!existing) return json({ error: "Not found." }, 404);
      const body = await readJson(request);
      if (!body) return json({ error: "Bad request." }, 400);
      const { value, errors } = validateArticle({ ...existing, ...body });
      if (errors.length) return json({ error: errors[0], errors }, 400);
      try {
        return json(await store.updateArticle(env.DB, id, value));
      } catch (e) {
        if (store.isUniqueViolation(e)) return json({ error: "Another article already uses that address (slug)." }, 409);
        throw e;
      }
    }
    if (!action && method === "DELETE") {
      return (await store.deleteArticle(env.DB, id)) ? json({ ok: true }) : json({ error: "Not found." }, 404);
    }
    if (action && method === "POST") {
      const existing = await store.getById(env.DB, id);
      if (!existing) return json({ error: "Not found." }, 404);
      if (action === "publish" && !existing.body_md.trim()) return json({ error: "Write something before publishing." }, 400);
      return json(await store.setStatus(env.DB, id, action === "publish" ? "published" : "draft"));
    }
  }

  if (sub === "preview" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.body_md !== "string") return json({ error: "Bad request." }, 400);
    return json({ html: renderMarkdown(body.body_md), excerpt: excerpt(body.body_md) });
  }
  if (sub === "external" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.url !== "string") return json({ error: "Bad request." }, 400);
    const r = await addByAddress(env, body.url, deps.fetch || fetch);
    return json(r.body, r.status);
  }
  if (sub === "media/import" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.url !== "string") return json({ error: "Bad request." }, 400);
    const r = await importImage(env, body.url);
    return json(r.body, r.status);
  }
  if (sub === "media" && method === "POST") {
    const r = await uploadImage(env, request);
    return json(r.body, r.status);
  }
  return json({ error: "Not found." }, 404);
}
