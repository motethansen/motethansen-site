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
import { renderMarkdown, excerpt } from "./render.js";
import { validateArticle } from "./validate.js";
import { uploadImage, serveImage } from "./media.js";
import { articlePage, feedEntry, rssFeed } from "./templates.js";
import { siteOf, ENABLED_SITES } from "./sites.js";

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

export async function route(request, env) {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const method = request.method;

  if (path.startsWith("/api/admin/")) return admin(request, env, path.slice("/api/admin/".length), method);

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
    const list = (await store.listArticles(env.DB, { status: "published", site, limit: 30 }));
    const full = await Promise.all(list.map(a => store.getById(env.DB, a.id)));
    return new Response(rssFeed(site, full, full.map(a => renderMarkdown(a.body_md))), {
      headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }
  const m = path.match(/^\/writing\/([a-z0-9][a-z0-9-]{1,98}[a-z0-9])\/?$/);
  if (m) {
    const a = await store.getPublishedBySlug(env.DB, m[1], site);
    if (!a) return new Response("Not found", { status: 404 });
    return html(articlePage(site, a, renderMarkdown(a.body_md)), 200, { "Cache-Control": "public, max-age=60, s-maxage=120" });
  }
  return new Response("Not found", { status: 404 });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function admin(request, env, sub, method) {
  if (sub === "login" && method === "POST") return login({ request, env });
  if (sub === "logout" && method === "POST") return logout({ request, env });
  if (sub === "me" && method === "GET") return me({ request, env });

  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (method !== "GET" && !sameOrigin(request)) return json({ error: "Bad origin." }, 403);

  if (sub === "config" && method === "GET") return json({ sites: ENABLED_SITES });

  if (sub === "articles" && method === "GET") {
    const u = new URL(request.url);
    const status = ["draft", "published"].includes(u.searchParams.get("status")) ? u.searchParams.get("status") : null;
    return json({ articles: await store.listArticles(env.DB, { status, q: u.searchParams.get("q") || null }) });
  }
  if (sub === "articles" && method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "Bad request." }, 400);
    const { value, errors } = validateArticle({ sites: ENABLED_SITES, ...body });
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
  if (sub === "media" && method === "POST") {
    const r = await uploadImage(env, request);
    return json(r.body, r.status);
  }
  return json({ error: "Not found." }, 404);
}
