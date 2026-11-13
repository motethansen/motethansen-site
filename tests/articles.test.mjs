import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../workers/articles/src/index.js";
import { renderMarkdown, excerpt } from "../workers/articles/src/render.js";
import { slugify, validateArticle } from "../workers/articles/src/validate.js";
import { makeEnv, PNG } from "./helpers.mjs";

const ORIGIN = "https://motethansen.com";
const call = (env, path, { method = "GET", body, cookie, origin = ORIGIN, headers = {}, raw } = {}) =>
  route(new Request(ORIGIN + path, {
    method,
    headers: { ...(raw ? {} : body ? { "content-type": "application/json" } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), "cf-connecting-ip": "9.9.9.9", ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  }), env);

async function signedIn(env) {
  const r = await call(env, "/api/admin/login", { method: "POST", body: { username: "michael", password: "correct horse battery" } });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const make = async (env, cookie, over = {}) =>
  (await (await call(env, "/api/admin/articles", { method: "POST", cookie, body: { title: "Hello World", body_md: "Some **text**", ...over } })).json());

// ---------- rendering ----------
test("render: raw HTML and script vectors are neutralised", () => {
  const h = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![a](javascript:alert(1))\n\n[d](data:text/html;base64,AAAA)');
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<img[^>]*onerror/i);
  assert.doesNotMatch(h, /href="javascript:/i);
  assert.doesNotMatch(h, /src="javascript:/i);
  assert.doesNotMatch(h, /href="data:/i);
});
test("render: images only from /media/ or https; external links are hardened", () => {
  assert.match(renderMarkdown("![ok](/media/2026/11/" + "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) + ".png)"), /<img src="\/media\//);
  assert.match(renderMarkdown("![ok](https://example.com/a.png)"), /<img src="https:\/\/example\.com/);
  assert.doesNotMatch(renderMarkdown("![tracker](http://example.com/a.png)"), /<img/);
  assert.doesNotMatch(renderMarkdown("![rel](../../etc/passwd)"), /<img/);
  assert.match(renderMarkdown("[a](https://example.com)"), /rel="noopener noreferrer"/);
  assert.match(excerpt("# Title\n\nSome **bold** text with [a link](https://x.y) and more words ".repeat(10), 60), /…$/);
});

// ---------- validation ----------
test("slugify and validateArticle", () => {
  assert.equal(slugify("Smart Cities & the 'Trap'!  Part 2"), "smart-cities-and-the-trap-part-2");
  assert.equal(slugify("Café Déjà vu"), "cafe-deja-vu");
  const ok = validateArticle({ title: "A title", sites: ["motethansen"] });
  assert.deepEqual(ok.errors, []); assert.equal(ok.value.slug, "a-title");
  for (const bad of [
    { title: "", sites: ["motethansen"] }, { title: "x".repeat(201), sites: ["motethansen"] },
    { title: "T", slug: "Bad Slug", sites: ["motethansen"] }, { title: "T", slug: "admin", sites: ["motethansen"] },
    { title: "T", sites: [] }, { title: "T", sites: ["evil"] }, { title: "T", sites: ["motethansen"], cover: "http://x/y.png" },
    { title: "T", sites: ["motethansen"], cover: "javascript:alert(1)" }, { title: "T", sites: ["motethansen"], origin_url: "ftp://x" },
    { title: "T", sites: ["motethansen"], published_at: "yesterday" }, { title: "T", sites: ["motethansen"], tags: Array(11).fill("a").map((x, i) => x + i) },
  ]) assert.ok(validateArticle(bad).errors.length, JSON.stringify(bad));
});

// ---------- admin API: auth ----------
test("every admin endpoint needs a session", async () => {
  const env = makeEnv();
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [m, p] of [["GET", "/api/admin/articles"], ["POST", "/api/admin/articles"], ["GET", `/api/admin/articles/${id}`],
    ["PUT", `/api/admin/articles/${id}`], ["DELETE", `/api/admin/articles/${id}`], ["POST", `/api/admin/articles/${id}/publish`],
    ["POST", "/api/admin/preview"], ["POST", "/api/admin/media"], ["GET", "/api/admin/config"]]) {
    assert.equal((await call(env, p, { method: m, body: m === "GET" ? undefined : {} })).status, 401, `${m} ${p}`);
  }
});
test("mutations from another origin are refused even when signed in", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const r = await call(env, "/api/admin/articles", { method: "POST", cookie, origin: "https://evil.example", body: { title: "x" } });
  assert.equal(r.status, 403);
  assert.equal((await call(env, "/api/admin/articles", { method: "POST", cookie, origin: null, body: { title: "x" } })).status, 403);
});

// ---------- admin API: CRUD + lifecycle ----------
test("create, read, update, list, delete", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie);
  assert.equal(a.slug, "hello-world"); assert.equal(a.status, "draft"); assert.deepEqual(a.sites, ["motethansen"]);

  const dup = await call(env, "/api/admin/articles", { method: "POST", cookie, body: { title: "Hello World" } });
  assert.equal(dup.status, 409);

  const put = await call(env, `/api/admin/articles/${a.id}`, { method: "PUT", cookie, body: { title: "Hello again", description: "d", tags: ["AI", "ai", "urban"], body_md: "New body" } });
  const u = await put.json();
  assert.equal(u.title, "Hello again"); assert.equal(u.slug, "hello-world"); assert.deepEqual(u.tags, ["ai", "urban"]);

  const bad = await call(env, `/api/admin/articles/${a.id}`, { method: "PUT", cookie, body: { slug: "NOT valid" } });
  assert.equal(bad.status, 400);

  const list = await (await call(env, "/api/admin/articles?status=draft", { cookie })).json();
  assert.equal(list.articles.length, 1); assert.equal(list.articles[0].body_md, undefined);   // list omits bodies
  assert.equal((await (await call(env, "/api/admin/articles?q=again", { cookie })).json()).articles.length, 1);
  assert.equal((await (await call(env, "/api/admin/articles?q=zzz", { cookie })).json()).articles.length, 0);

  assert.equal((await call(env, `/api/admin/articles/${a.id}`, { method: "DELETE", cookie })).status, 200);
  assert.equal((await call(env, `/api/admin/articles/${a.id}`, { cookie })).status, 404);
});
test("a slug used by another article cannot be taken on update", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  await make(env, cookie, { title: "First one" });
  const b = await make(env, cookie, { title: "Second one" });
  const r = await call(env, `/api/admin/articles/${b.id}`, { method: "PUT", cookie, body: { slug: "first-one" } });
  assert.equal(r.status, 409);
});
test("LIKE wildcards in the search box are matched literally", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  await make(env, cookie, { title: "100% real" }); await make(env, cookie, { title: "Other thing" });
  assert.equal((await (await call(env, "/api/admin/articles?q=%25", { cookie })).json()).articles.length, 1);
});

test("publish needs content; drafts are invisible; published shows, with the right metadata", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const empty = await make(env, cookie, { title: "Empty one", body_md: "  " });
  assert.equal((await call(env, `/api/admin/articles/${empty.id}/publish`, { method: "POST", cookie })).status, 400);

  const a = await make(env, cookie, { title: "Smart cities", description: "About cities", body_md: "# Heading\n\nBody **bold**" });
  assert.equal((await call(env, "/writing/smart-cities/")).status, 404);                 // draft
  assert.equal((await (await call(env, "/writing/index.json")).json()).articles.length, 0);

  const pub = await (await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie })).json();
  assert.equal(pub.status, "published"); assert.ok(pub.published_at > 1_700_000_000);

  const page = await call(env, "/writing/smart-cities/");
  assert.equal(page.status, 200);
  const h = await page.text();
  assert.match(h, /<title>Smart cities — Michael Motet Hansen<\/title>/);
  assert.match(h, /rel="canonical" href="https:\/\/motethansen\.com\/writing\/smart-cities\/"/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /"@type":"Article"/);
  assert.equal((await call(env, "/writing/smart-cities")).status, 200);                  // no trailing slash

  const idx = await (await call(env, "/writing/index.json")).json();
  assert.equal(idx.articles.length, 1);
  assert.equal(idx.articles[0].url, "https://motethansen.com/writing/smart-cities/");
  assert.equal(idx.articles[0].platform, "motethansen.com");

  const rss = await (await call(env, "/writing/rss.xml")).text();
  assert.match(rss, /<item>[\s\S]*Smart cities[\s\S]*<\/item>/); assert.match(rss, /CDATA\[<h1>Heading/);

  await call(env, `/api/admin/articles/${a.id}/unpublish`, { method: "POST", cookie });
  assert.equal((await call(env, "/writing/smart-cities/")).status, 404);
});
test("republishing keeps the original publish date", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie);
  const first = await (await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie })).json();
  await call(env, `/api/admin/articles/${a.id}/unpublish`, { method: "POST", cookie });
  const again = await (await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie })).json();
  assert.equal(again.published_at, first.published_at);
});
test("an article body cannot inject script into its public page", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie, { title: "Evil one", body_md: '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))' });
  await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });
  const h = await (await call(env, "/writing/evil-one/")).text();
  assert.doesNotMatch(h, /<script>alert/); assert.doesNotMatch(h, /<img[^>]*onerror/i); assert.doesNotMatch(h, /href="javascript:/);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);               // shown as text, never executed
});
test("a title with quotes cannot break out of the meta tags", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie, { title: 'He said "hi" <b>', description: '"><script>x</script>' });
  await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });
  const h = await (await call(env, `/writing/${a.slug}/`)).text();
  assert.doesNotMatch(h, /<script>x<\/script>/); assert.doesNotMatch(h, /<b>/);
});

test("preview renders sanitised HTML", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const r = await (await call(env, "/api/admin/preview", { method: "POST", cookie, body: { body_md: "**hi** <script>1</script>" } })).json();
  assert.match(r.html, /<strong>hi<\/strong>/); assert.doesNotMatch(r.html, /<script>/);
});

// ---------- media ----------
test("image upload: accepted types stored and served; wrong type, spoofed bytes and oversize refused", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const up = await call(env, "/api/admin/media", { method: "POST", cookie, raw: PNG, headers: { "content-type": "image/png" } });
  assert.equal(up.status, 201);
  const { key, url } = await up.json();
  assert.match(url, /^\/media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  const got = await call(env, url);
  assert.equal(got.status, 200); assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");

  assert.equal((await call(env, "/api/admin/media", { method: "POST", cookie, raw: PNG, headers: { "content-type": "image/svg+xml" } })).status, 415);
  assert.equal((await call(env, "/api/admin/media", { method: "POST", cookie, raw: "<svg onload=alert(1)>", headers: { "content-type": "image/png" } })).status, 415);
  assert.equal((await call(env, "/api/admin/media", { method: "POST", cookie, raw: new Uint8Array(5 * 1024 * 1024 + 10).fill(1), headers: { "content-type": "image/png" } })).status, 413);
  assert.equal((await call(env, "/media/../../etc/passwd")).status, 404);
  assert.equal((await call(env, "/media/2026/11/not-a-uuid.png")).status, 404);
  assert.ok(env.MEDIA.m.has(key));
});
test("a cover uploaded through the API validates; arbitrary paths do not", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const { url } = await (await call(env, "/api/admin/media", { method: "POST", cookie, raw: PNG, headers: { "content-type": "image/png" } })).json();
  assert.equal((await call(env, "/api/admin/articles", { method: "POST", cookie, body: { title: "With cover", cover: url } })).status, 201);
  assert.equal((await call(env, "/api/admin/articles", { method: "POST", cookie, body: { title: "Bad cover", cover: "/etc/passwd" } })).status, 400);
});

// ---------- routing ----------
test("public routes only answer GET/HEAD; unknown paths 404; vizneo.com is served too", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/writing/x-y-z/", { method: "POST" })).status, 405);
  assert.equal((await call(env, "/nope")).status, 404);
  const viz = await route(new Request("https://vizneo.com/writing/index.json"), env);
  assert.equal(viz.status, 200);
});

test("an article published for another site never appears on this one", async () => {
  const env = makeEnv();
  env.DB.raw.exec(`INSERT INTO articles (id, slug, title, body_md, sites, status, published_at, created_at, updated_at)
                   VALUES ('22222222-2222-4222-8222-222222222222', 'other-site-only', 'Other site', 'x', '["vizneo"]', 'published', 1700000000, 1700000000, 1700000000)`);
  assert.equal((await call(env, "/writing/other-site-only/")).status, 404);
  assert.equal((await (await call(env, "/writing/index.json")).json()).articles.length, 0);
  assert.doesNotMatch(await (await call(env, "/writing/rss.xml")).text(), /Other site/);
});

test("the cover is shown with a relative path (works on any host) but advertised with an absolute og:image", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const { url } = await (await call(env, "/api/admin/media", { method: "POST", cookie, raw: PNG, headers: { "content-type": "image/png" } })).json();
  const a = await make(env, cookie, { title: "Cover page", cover: url });
  await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });
  const h = await (await call(env, "/writing/cover-page/")).text();
  assert.ok(h.includes(`<img class="article__cover" src="${url}"`));
  assert.ok(h.includes(`<meta property="og:image" content="https://motethansen.com${url}">`));
});

// ---------- vizneo.com as a second site ----------
import { importAllowed, importImage } from "../workers/articles/src/media.js";
const VIZ = "https://vizneo.com";
// same helper but with the vizneo.com host
const vcall = (env, path, { method = "GET", body, cookie, raw, headers = {} } = {}) =>
  route(new Request(VIZ + path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), origin: VIZ, ...(cookie ? { cookie } : {}), "cf-connecting-ip": "8.8.8.8", ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  }), env);
async function vizSignedIn(env) {
  const r = await vcall(env, "/api/admin/login", { method: "POST", body: { username: "michael", password: "correct horse battery" } });
  assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0];
}

test("vizneo.com: articles created there default to the vizneo site, render with its template and canonical, and list/RSS/JSON", async () => {
  const env = makeEnv(); const cookie = await vizSignedIn(env);
  const a = await (await vcall(env, "/api/admin/articles", { method: "POST", cookie, body: { title: "From LinkedIn", body_md: "Body **here**", description: "migrated" } })).json();
  assert.deepEqual(a.sites, ["vizneo"]);
  await vcall(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });

  const page = await (await vcall(env, "/writing/from-linkedin/")).text();
  assert.match(page, /rel="canonical" href="https:\/\/vizneo\.com\/writing\/from-linkedin\/"/);
  assert.match(page, /vizneo_shape_logo_color\.svg/); assert.match(page, /Fraunces/);
  assert.doesNotMatch(page, /motethansen/i);
  assert.match(page, /<strong>here<\/strong>/);

  const list = await (await vcall(env, "/writing/")).text();
  assert.match(list, /From LinkedIn/); assert.match(list, /href="https:\/\/vizneo\.com\/writing\/from-linkedin\/"/);
  assert.equal((await vcall(env, "/writing")).status, 200);

  const idx = await (await vcall(env, "/writing/index.json")).json();
  assert.equal(idx.articles[0].platform, "vizneo.com");
  assert.match(await (await vcall(env, "/writing/rss.xml")).text(), /<link>https:\/\/vizneo\.com\/writing\/<\/link>/);

  // and it is invisible on motethansen.com
  assert.equal((await call(env, "/writing/from-linkedin/")).status, 404);
  assert.equal((await (await call(env, "/writing/index.json")).json()).articles.length, 0);
});
test("an article can be published on both sites, and each serves its own canonical", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie, { title: "On both", sites: ["motethansen", "vizneo"] });
  await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });
  assert.match(await (await call(env, "/writing/on-both/")).text(), /canonical" href="https:\/\/motethansen\.com\//);
  assert.match(await (await vcall(env, "/writing/on-both/")).text(), /canonical" href="https:\/\/vizneo\.com\//);
});
test("config tells the editor which sites exist and which one it is on", async () => {
  const env = makeEnv(); const cookie = await vizSignedIn(env);
  const c = await (await vcall(env, "/api/admin/config", { cookie })).json();
  assert.deepEqual(c.sites, ["motethansen", "vizneo"]); assert.equal(c.current, "vizneo");
});

// ---------- editor UI served by the Worker ----------
test("the editor is served from assets with strict headers; /admin redirects to /admin/", async () => {
  const env = { ...makeEnv(), ASSETS: { fetch: async () => new Response("<!doctype html>admin", { headers: { "content-type": "text/html" } }) } };
  const r = await call(env, "/admin/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/); assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.equal(r.headers.get("cache-control"), "no-store");
  const redirect = await call(env, "/admin");
  assert.equal(redirect.status, 308); assert.match(redirect.headers.get("location"), /\/admin\/$/);
  assert.equal((await call(env, "/admin/x", { method: "POST" })).status, 405);
});

// ---------- importing pasted images (SSRF-safe) ----------
test("image import: only LinkedIn/Substack CDN hosts over plain https, no credentials, no tricks", () => {
  for (const ok of ["https://media.licdn.com/dms/image/v2/abc/x.jpg", "https://media-exp1.licdn.com/a.png", "https://substackcdn.com/image/fetch/a.png",
    "https://substack-post-media.s3.amazonaws.com/public/images/a.jpeg"]) assert.ok(importAllowed(ok), ok);
  for (const bad of ["http://media.licdn.com/a.jpg", "https://licdn.com/a.jpg", "https://media.licdn.com.evil.com/a.jpg", "https://evil.com/media.licdn.com/a.jpg",
    "https://media.licdn.com@evil.com/a.jpg", "https://user:pw@media.licdn.com/a.jpg", "https://media.licdn.com:8443/a.jpg", "https://localhost/a.png",
    "https://169.254.169.254/latest/meta-data", "ftp://media.licdn.com/a", "javascript:alert(1)", "not a url", "https://notsubstackcdn.com/a.png"]) {
    assert.equal(importAllowed(bad), null, bad);
  }
});
test("image import: stores real images, refuses redirects, non-images, HTML pretending to be an image and oversize", async () => {
  const env = makeEnv();
  const png = (over = {}) => async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" }, ...over });
  const ok = await importImage(env, "https://media.licdn.com/dms/image/x.png", png());
  assert.equal(ok.status, 201); assert.match(ok.body.url, /^\/media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/); assert.ok(env.MEDIA.m.has(ok.body.key));
  assert.equal((await importImage(env, "https://evil.com/a.png", png())).status, 400);
  assert.equal((await importImage(env, "https://media.licdn.com/a.png", async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }))).status, 502);
  assert.equal((await importImage(env, "https://media.licdn.com/a.png", async () => new Response("<html>login</html>", { status: 200 }))).status, 415);
  assert.equal((await importImage(env, "https://media.licdn.com/a.png", async () => new Response(new Uint8Array(5 * 1024 * 1024 + 10).fill(1), { status: 200 }))).status, 413);
  assert.equal((await importImage(env, "https://media.licdn.com/a.png", async () => { throw new Error("network"); })).status, 502);
  const calls = []; await importImage(env, "https://media.licdn.com/a.png", async (u, init) => { calls.push(init.redirect); return new Response(PNG); });
  assert.deepEqual(calls, ["manual"]);                                                       // redirects are never followed
});
test("the import endpoint needs a session and rejects bad hosts", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/admin/media/import", { method: "POST", body: { url: "https://media.licdn.com/a.png" } })).status, 401);
  const cookie = await signedIn(env);
  assert.equal((await call(env, "/api/admin/media/import", { method: "POST", cookie, body: { url: "https://evil.com/a.png" } })).status, 400);
  assert.equal((await call(env, "/api/admin/media/import", { method: "POST", cookie, body: {} })).status, 400);
});

// ---------- linked-out entries pushed by the mac-mini (Substack) ----------
const TOKEN = "ingest-token-for-tests-0123456789";
const push = (env, body, { token = TOKEN, method = "POST" } = {}) =>
  route(new Request(ORIGIN + "/api/ingest/external", {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body),
  }), { ...env, INGEST_TOKEN: TOKEN });
const va = (over = {}) => ({ url: "https://vizneoacademy.substack.com/p/from-one-prompt", title: "From one prompt to a Scrum team", date: "2026-11-12T04:36:19Z",
  description: "Building distributed-infra", image: "https://substackcdn.com/image/fetch/x.png", ...over });

test("ingest: needs the bearer token; an unset token admits nobody", async () => {
  const env = makeEnv();
  assert.equal((await push(env, { source: "va-substack", entries: [va()] }, { token: null })).status, 401);
  assert.equal((await push(env, { source: "va-substack", entries: [va()] }, { token: "wrong" })).status, 401);
  const noSecret = await route(new Request(ORIGIN + "/api/ingest/external", { method: "POST", headers: { authorization: "Bearer " } , body: "{}" }), makeEnv());
  assert.equal(noSecret.status, 401);
  assert.equal((await push(env, {}, { method: "GET" })).status, 405);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM articles").get().c, 0);
});
test("ingest: inserts, then updates by address without duplicating, and records the sync time", async () => {
  const env = makeEnv();
  const first = await (await push(env, { source: "va-substack", entries: [va()] })).json();
  assert.deepEqual([first.inserted, first.updated], [1, 0]);
  const again = await (await push(env, { source: "va-substack", entries: [va({ title: "From one prompt to a Scrum team (edited)" })] })).json();
  assert.deepEqual([again.inserted, again.updated], [0, 1]);
  const rows = env.DB.raw.prepare("SELECT title, source, platform, external_url, status, sites FROM articles").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].title, "From one prompt to a Scrum team (edited)");
  assert.deepEqual([rows[0].source, rows[0].platform, rows[0].status], ["Vizneo Academy", "Substack", "published"]);
  const sync = await env.SITE_KV.get("external-sync-v1:va-substack", "json");
  assert.ok(sync.ts > 1_700_000_000); assert.equal(sync.seen, 1);
});
test("ingest: validates the source, the host for that source, titles and dates; bad entries are skipped, good ones kept", async () => {
  const env = makeEnv();
  assert.equal((await push(env, { source: "nope", entries: [va()] })).status, 400);
  assert.equal((await push(env, { source: "va-substack", entries: [] })).status, 400);
  assert.equal((await push(env, { source: "va-substack", entries: Array(201).fill(va()) })).status, 400);
  const r = await (await push(env, { source: "ulw-substack", entries: [
    va({ url: "https://urbanlifeworks.substack.com/p/ok", title: "Good" }),
    va({ url: "https://vizneoacademy.substack.com/p/wrong-publication" }),        // another publication's host
    va({ url: "http://urbanlifeworks.substack.com/p/plain-http" }),
    va({ url: "https://evil.com/p/x" }), va({ url: "https://urbanlifeworks.substack.com@evil.com/p/x" }),
    va({ url: "https://urbanlifeworks.substack.com/p/no-title", title: "" }),
  ] })).json();
  assert.equal(r.inserted, 1); assert.equal(r.skipped.length, 5);
  const odd = await (await push(env, { source: "ulw-substack", entries: [va({ url: "https://urbanlifeworks.substack.com/p/odd", date: "not a date", image: "http://x/y.png" })] })).json();
  assert.equal(odd.inserted, 1);
  const row = env.DB.raw.prepare("SELECT published_at, cover FROM articles WHERE external_url LIKE '%/odd'").get();
  assert.equal(row.published_at, null); assert.equal(row.cover, null);               // bad date and non-https image are dropped, not stored
});
test("linked-out entries: listed on the sites their source is configured for, link out, never get a page or an RSS item", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  await push(env, { source: "va-substack", entries: [va()] });
  await push(env, { source: "ulw-substack", entries: [va({ url: "https://urbanlifeworks.substack.com/p/ulw-one", title: "ULW piece" })] });

  const moth = (await (await call(env, "/writing/index.json")).json()).articles;
  assert.deepEqual(moth.map(a => a.title).sort(), ["From one prompt to a Scrum team", "ULW piece"]);
  const e = moth.find(a => a.title === "ULW piece");
  assert.equal(e.url, "https://urbanlifeworks.substack.com/p/ulw-one"); assert.equal(e.platform, "Substack"); assert.equal(e.source, "Urban Life Works");

  const viz = (await (await vcall(env, "/writing/index.json")).json()).articles;
  assert.deepEqual(viz.map(a => a.title), ["From one prompt to a Scrum team"]);       // Vizneo Academy only, not Urban Life Works
  const vizList = await (await vcall(env, "/writing/")).text();
  assert.match(vizList, /href="https:\/\/vizneoacademy\.substack\.com\/p\/from-one-prompt" target="_blank"/); assert.match(vizList, /Substack, Vizneo Academy/);

  const slug = env.DB.raw.prepare("SELECT slug FROM articles WHERE title = 'ULW piece'").get().slug;
  assert.equal((await call(env, `/writing/${slug}/`)).status, 404);                   // no page of our own
  assert.doesNotMatch(await (await call(env, "/writing/rss.xml")).text(), /ULW piece/);
  assert.equal((await (await call(env, "/api/admin/articles", { cookie })).json()).articles.length, 0);   // editor list shows only what is written here
});
test("a hidden linked-out entry stays hidden through the next sync", async () => {
  const env = makeEnv();
  await push(env, { source: "va-substack", entries: [va()] });
  env.DB.raw.exec("UPDATE articles SET status = 'draft'");
  await push(env, { source: "va-substack", entries: [va({ title: "Renamed upstream" })] });
  const row = env.DB.raw.prepare("SELECT status, title FROM articles").get();
  assert.deepEqual([row.status, row.title], ["draft", "Renamed upstream"]);
  assert.equal((await (await call(env, "/writing/index.json")).json()).articles.length, 0);
});

// ---------- add a Substack post by address ----------
import { parsePostAddress, parseOg, titleFromSlug } from "../workers/articles/src/substack.js";
const POST_HTML = `<html><head>
<meta property="og:title" content="From one prompt to a Scrum team &amp; more">
<meta property="og:description" content="Building distributed-infra">
<meta property="og:image" content="https://substackcdn.com/image/fetch/cover.png">
<meta property="article:published_time" content="2026-11-12T04:36:19.170Z"></head><body>x</body></html>`;
const addPost = (env, cookie, url, fetcher) =>
  route(new Request(ORIGIN + "/api/admin/external", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify({ url }) }), env, { fetch: fetcher });
const PAGE = "https://vizneoacademy.substack.com/p/from-one-prompt-to-a-scrum-team";

test("substack address: only posts on our two publications, normalised", () => {
  assert.equal(parsePostAddress(PAGE + "/?utm_source=x#c").url, PAGE);
  assert.equal(parsePostAddress(PAGE).id, "va-substack");
  assert.equal(parsePostAddress("https://urbanlifeworks.substack.com/p/abc").id, "ulw-substack");
  for (const bad of ["http://vizneoacademy.substack.com/p/x", "https://vizneoacademy.substack.com/", "https://vizneoacademy.substack.com/about",
    "https://othersite.substack.com/p/x", "https://evil.com/p/x", "https://vizneoacademy.substack.com@evil.com/p/x", "https://u:p@vizneoacademy.substack.com/p/x",
    "https://vizneoacademy.substack.com:8443/p/x", "https://vizneoacademy.substack.com/p/x/y", "https://www.linkedin.com/pulse/a-b-c", "nope"]) {
    assert.equal(parsePostAddress(bad), null, bad);
  }
  assert.equal(titleFromSlug("from-one-prompt--to-a-scrum-team"), "From one prompt to a scrum team");
  assert.deepEqual(parseOg(POST_HTML), { title: "From one prompt to a Scrum team & more", description: "Building distributed-infra", image: "https://substackcdn.com/image/fetch/cover.png", date: "2026-11-12T04:36:19.170Z" });
});
test("add by address: needs a session; bad addresses are refused without any fetch", async () => {
  const env = makeEnv(); let fetched = 0; const f = async () => { fetched++; return new Response(POST_HTML); };
  assert.equal((await addPost(env, "", PAGE, f)).status, 401);
  const cookie = await signedIn(env);
  assert.equal((await addPost(env, cookie, "https://evil.com/p/x", f)).status, 400);
  assert.equal(fetched, 0);                                                           // never fetches an address we did not accept
});
test("add by address: Substack readable -> full details, listed on the right sites, and the pull can refresh it later", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const r = await (await addPost(env, cookie, PAGE + "?utm=1", async () => new Response(POST_HTML, { status: 200 }))).json();
  assert.equal(r.state, "added"); assert.equal(r.title, "From one prompt to a Scrum team & more");
  const row = env.DB.raw.prepare("SELECT title, description, cover, published_at, sites, external_url FROM articles").get();
  assert.equal(row.external_url, PAGE); assert.equal(row.published_at, Math.floor(Date.parse("2026-11-12T04:36:19.170Z") / 1000));
  assert.deepEqual(JSON.parse(row.sites), ["motethansen", "vizneo"]);
  assert.equal((await (await vcall(env, "/writing/index.json")).json()).articles.length, 1);   // Vizneo Academy shows on vizneo.com too
  const again = await (await addPost(env, cookie, PAGE, async () => new Response(POST_HTML))).json();
  assert.equal(again.state, "updated"); assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM articles").get().c, 1);
});
test("add by address: Substack blocks us (429, error, timeout) -> listed now with a title from the address; the pull later fixes it", async () => {
  for (const f of [async () => new Response("slow down", { status: 429 }), async () => new Response("oops", { status: 503 }), async () => { throw new Error("network"); },
    async () => new Response("<html>challenge</html>", { status: 200 })]) {
    const env = makeEnv(); const cookie = await signedIn(env);
    const r = await (await addPost(env, cookie, PAGE, f)).json();
    assert.equal(r.state, "queued"); assert.equal(r.title, "From one prompt to a scrum team"); assert.match(r.note, /within 10 minutes/);
    // the next pull pushes the real details under the same address: one row, now correct
    await push(env, { source: "va-substack", entries: [va({ url: PAGE, title: "From one prompt to a Scrum team", date: "2026-11-12T04:36:19Z" })] });
    const rows = env.DB.raw.prepare("SELECT title, published_at FROM articles").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].title, "From one prompt to a Scrum team");
    assert.equal(rows[0].published_at, Math.floor(Date.parse("2026-11-12T04:36:19Z") / 1000));
  }
});
test("add by address: a blocked fetch never overwrites real details that are already stored; a 404 is refused and stores nothing", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  await push(env, { source: "va-substack", entries: [va({ url: PAGE, title: "Real title" })] });
  const r = await (await addPost(env, cookie, PAGE, async () => new Response("", { status: 429 }))).json();
  assert.equal(r.state, "exists"); assert.equal(env.DB.raw.prepare("SELECT title FROM articles").get().title, "Real title");
  const env2 = makeEnv(); const cookie2 = await signedIn(env2);
  const nf = await addPost(env2, cookie2, "https://urbanlifeworks.substack.com/p/typo-post", async () => new Response("", { status: 404 }));
  assert.equal(nf.status, 404); assert.equal(env2.DB.raw.prepare("SELECT COUNT(*) c FROM articles").get().c, 0);
});

test("provisional entries: confirmed by the pull, or removed when the pull never sees them after 30 minutes; confirmed ones are never removed", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const blocked = async () => new Response("", { status: 429 });
  const typo = "https://vizneoacademy.substack.com/p/typo-in-the-address";
  await addPost(env, cookie, PAGE, blocked); await addPost(env, cookie, typo, blocked);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM articles WHERE provisional = 1").get().c, 2);

  // a pull right away must not remove anything (grace period) but confirms the real post
  let r = await (await push(env, { source: "va-substack", entries: [va({ url: PAGE })] })).json();
  assert.equal(r.removed, 0);
  assert.equal(env.DB.raw.prepare("SELECT provisional p FROM articles WHERE external_url = ?").get(PAGE).p, 0);   // confirmed
  assert.equal(env.DB.raw.prepare("SELECT provisional p FROM articles WHERE external_url = ?").get(typo).p, 1);

  // a confirmed (real) post that has dropped out of the feed window must survive every later pull
  const OLD = "https://vizneoacademy.substack.com/p/an-older-real-post";
  await push(env, { source: "va-substack", entries: [va({ url: PAGE }), va({ url: OLD, title: "Older real post" })] });

  // 31 minutes later the typo is still unseen -> removed; the confirmed post and other sources' rows survive
  env.DB.raw.exec("UPDATE articles SET created_at = created_at - 3600");
  await push(env, { source: "ulw-substack", entries: [va({ url: "https://urbanlifeworks.substack.com/p/ulw-one", title: "ULW" })] });
  r = await (await push(env, { source: "va-substack", entries: [va({ url: PAGE })] })).json();
  assert.equal(r.removed, 1);
  const left = env.DB.raw.prepare("SELECT external_url FROM articles ORDER BY external_url").all().map(x => x.external_url);
  assert.deepEqual(left, [OLD, "https://urbanlifeworks.substack.com/p/ulw-one", PAGE].sort());
});

// ---------- YouTube embeds ----------
import { youtubeId } from "../workers/articles/src/render.js";
const VID = "dQw4w9WgXcQ";
const player = h => h.match(/<iframe src="([^"]+)"/)?.[1];

test("youtube: a bare address on its own line becomes a nocookie player, in every common form", () => {
  for (const u of [`https://www.youtube.com/watch?v=${VID}`, `https://youtube.com/watch?v=${VID}&t=42s`, `https://www.youtube.com/watch?feature=share&v=${VID}`,
    `https://youtu.be/${VID}`, `https://youtu.be/${VID}?t=30`, `https://m.youtube.com/watch?v=${VID}`, `https://www.youtube.com/shorts/${VID}`,
    `https://www.youtube.com/embed/${VID}`, `https://www.youtube.com/live/${VID}`, `http://www.youtube.com/watch?v=${VID}`]) {
    const h = renderMarkdown(`Before\n\n${u}\n\nAfter`);
    assert.equal(player(h), `https://www.youtube-nocookie.com/embed/${VID}`, u);
    assert.match(h, /<p>Before<\/p>[\s\S]*<div class="video">[\s\S]*<p>After<\/p>/);
  }
});
test("youtube: only a lone address embeds; linked text, inline mentions and look-alike hosts stay ordinary", () => {
  assert.doesNotMatch(renderMarkdown(`[Watch the talk](https://youtu.be/${VID})`), /<iframe/);            // explicit link text stays a link
  assert.match(renderMarkdown(`[Watch the talk](https://youtu.be/${VID})`), /<a href="https:\/\/youtu\.be\//);
  assert.doesNotMatch(renderMarkdown(`See https://youtu.be/${VID} for more`), /<iframe/);                // inside a sentence
  assert.match(renderMarkdown(`- https://youtu.be/${VID}`), /<iframe/);                                   // a lone address in a list item is a video too
  for (const bad of [`https://youtube.com.evil.com/watch?v=${VID}`, `https://evil.com/youtu.be/${VID}`, `https://www.youtube.com.evil.com/embed/${VID}`,
    "https://www.youtube.com/watch?v=short", `https://www.youtube.com/watch?v=${VID}x`, `https://youtu.be/${VID}extra`, "https://www.youtube.com/channel/UCabcdefghijk",
    `javascript:alert(1)//youtu.be/${VID}`, `https://notyoutube.com/watch?v=${VID}`]) {
    assert.doesNotMatch(renderMarkdown(bad), /<iframe/, bad);
    assert.equal(youtubeId(bad), null, bad);
  }
});
test("youtube: the frame address can only ever contain an 11-character id", () => {
  const h = renderMarkdown(`https://www.youtube.com/watch?v=${VID}&x="><script>alert(1)</script>`);
  assert.doesNotMatch(h, /<script/);
  const src = player(h); assert.ok(!src || /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(src));
});
test("youtube: RSS gets a link instead of a frame; published pages and the editor preview get the player", async () => {
  const env = makeEnv(); const cookie = await signedIn(env);
  const a = await make(env, cookie, { title: "With video", body_md: `Intro\n\nhttps://youtu.be/${VID}\n\nOutro` });
  await call(env, `/api/admin/articles/${a.id}/publish`, { method: "POST", cookie });
  const page = await (await call(env, "/writing/with-video/")).text();
  assert.match(page, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/); assert.match(page, /\.video\{position:relative;aspect-ratio:16\/9/);
  const rss = await (await call(env, "/writing/rss.xml")).text();
  assert.doesNotMatch(rss, /<iframe/); assert.match(rss, /Watch the video on YouTube/);
  const prev = await (await call(env, "/api/admin/preview", { method: "POST", cookie, body: { body_md: `https://youtu.be/${VID}` } })).json();
  assert.match(prev.html, /<iframe/);
  const viz = await (await vcall(env, "/writing/with-video/")).text();      // not published on vizneo.com
  assert.doesNotMatch(viz, /iframe/);
});
test("the editor's security policy allows only the privacy-enhanced YouTube frame", async () => {
  const env = { ...makeEnv(), ASSETS: { fetch: async () => new Response("x") } };
  const csp = (await call(env, "/admin/")).headers.get("content-security-policy");
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com;/); assert.match(csp, /default-src 'none'/);
});
