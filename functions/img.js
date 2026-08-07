/**
 * GET /img?u=<absolute https URL>
 *
 * Re-serves feed thumbnails from our own origin.
 *
 * Why this exists: LinkedIn article covers are hosted on `media.licdn.com`, and
 * Firefox classifies LinkedIn as a **social tracker**. Enhanced Tracking
 * Protection therefore blocks the request outright — no extension, no login,
 * nothing wrong with the URL. ETP is on by default in private windows and in
 * Strict mode, so a large share of visitors saw LinkedIn cards with no image
 * while Substack's loaded fine. Confirmed 2026-08-07 from a clean private
 * window: "The resource at <URL> was blocked because Enhanced Tracking
 * Protection is enabled."
 *
 * Serving the same bytes from motethansen.com makes it a first-party request,
 * which ETP does not touch. It also stops leaking a Referer to LinkedIn on
 * every page view, and lets the edge cache the image.
 *
 * SAFETY
 *  - **Allowlisted hosts only.** An open image proxy is someone else's
 *    bandwidth bill and an SSRF surface; only the three hosts our own feed
 *    actually uses are accepted.
 *  - **Fails back, never fails closed.** Any problem — bad param, upstream
 *    error, non-image response — redirects to the original URL, which is
 *    exactly today's behaviour. A bug here degrades to the status quo instead
 *    of breaking the images that already work.
 */

/** Hosts observed in our own feed. Exact match, no suffix matching. */
const ALLOWED_HOSTS = new Set([
  "media.licdn.com", // LinkedIn article covers — the ones ETP blocks
  "substackcdn.com",
  "substack-post-media.s3.amazonaws.com",
]);

const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=86400";

/**
 * HEAD must be handled explicitly. Without it Pages falls through to the static
 * asset handler and answers `/img` with the site's HTML — so a link checker or
 * crawler is told this route is a text/html page. Same work as GET, no body.
 */
export async function onRequestHead(ctx) {
  const res = await onRequestGet(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}

export async function onRequestGet({ request, waitUntil }) {
  const raw = new URL(request.url).searchParams.get("u");
  if (!raw) return new Response("missing ?u", { status: 400 });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad ?u", { status: 400 });
  }

  // Anything we will not proxy is bounced to the origin rather than refused:
  // the browser then behaves exactly as it did before this endpoint existed.
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return Response.redirect(target.toString(), 302);
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      // No Referer, no cookies — we want the bytes, not a session.
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });
  } catch {
    return Response.redirect(target.toString(), 302);
  }

  const type = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !type.startsWith("image/")) {
    // An HTML error page rendered into an <img> is a broken icon either way;
    // let the browser try the original so nothing is worse than before.
    return Response.redirect(target.toString(), 302);
  }

  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });

  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
