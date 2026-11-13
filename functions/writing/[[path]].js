/**
 * /writing/<slug>/, /writing/rss.xml and /writing/index.json come from the articles service.
 * The archive page itself (/writing/) stays the static public/writing/index.html.
 *
 * An unknown address must answer 404. Falling through to the static site would not: Pages serves the home
 * page with a 200 for any path it does not know, which search engines would index as a duplicate.
 */
const NOT_FOUND = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Not found — Michael Motet Hansen</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="section"><div class="container"><h1 class="section__title">Article not found.</h1>
<p><a href="/writing/">See all articles</a></p></div></main></body></html>`;

export async function onRequest(context) {
  const { request, env, params } = context;
  const segs = [].concat(params.path || []).filter(Boolean);
  if (!segs.length || segs[0] === "index.html") return context.next();
  const res = await env.ARTICLES.fetch(request);
  if (res.status !== 404) return res;
  return new Response(request.method === "HEAD" ? null : NOT_FOUND, {
    status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
