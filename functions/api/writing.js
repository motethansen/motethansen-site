/**
 * GET /api/writing — the site's article list: everything in the article store that is published for this site
 * (articles written in /admin, plus the linked-out Substack and legacy LinkedIn entries).
 *
 *   ?all=1   the full list (the /writing archive page); default is the newest 9 (the home page)
 *
 * The store is filled by /admin and by the hourly Substack pull (scripts/substack_sync.py on the thinkpad), so this
 * function makes no request to Substack or LinkedIn. Response: { posts, total }.
 */
const HOME_LIMIT = 9;

export async function onRequestGet({ request, env }) {
  const wantAll = new URL(request.url).searchParams.get("all") === "1";
  let posts = [];
  try {
    const res = await env.ARTICLES.fetch("https://motethansen.com/writing/index.json");
    if (!res.ok) return jsonResponse({ error: "Articles are temporarily unavailable." }, 502);
    posts = (await res.json()).articles || [];
  } catch (e) {
    console.warn("[writing] articles service unreachable:", e?.message);
    return jsonResponse({ error: "Articles are temporarily unavailable." }, 502);
  }
  posts.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const shown = wantAll ? posts : posts.slice(0, HOME_LIMIT);
  return jsonResponse({ posts: proxyImages(shown), total: posts.length });
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

/**
 * Hosts whose images we re-serve from our own origin via /img. `media.licdn.com` is the one that matters: Firefox
 * classes LinkedIn as a social tracker, so Enhanced Tracking Protection blocks it outright. The Substack hosts are
 * proxied for the same caching and no-Referer benefit. Keep in sync with the allowlist in functions/img.js.
 */
const PROXY_IMAGE_HOSTS = new Set(["media.licdn.com", "substackcdn.com", "substack-post-media.s3.amazonaws.com"]);

/** Rewritten at response time only; the store keeps the original addresses. */
function proxyImages(posts) {
  return posts.map((p) => {
    if (!p.image) return p;
    let host;
    try { host = new URL(p.image).hostname; } catch { return p; }
    return PROXY_IMAGE_HOSTS.has(host) ? { ...p, image: `/img?u=${encodeURIComponent(p.image)}` } : p;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? "public, max-age=60" : "no-store", ...corsHeaders() },
  });
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}
