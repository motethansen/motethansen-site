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
test("public routes only answer GET/HEAD; unknown paths 404; vizneo.com is not enabled yet", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/writing/x-y-z/", { method: "POST" })).status, 405);
  assert.equal((await call(env, "/nope")).status, 404);
  const viz = await route(new Request("https://vizneo.com/writing/index.json"), env);
  assert.equal(viz.status, 404);
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
