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
