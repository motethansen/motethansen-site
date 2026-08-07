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
 * Resizing.
 *
 * These covers are card thumbnails rendered a few hundred pixels wide, and the
 * originals are not: LinkedIn serves up to ~1.4 MB PNGs. Now that we re-serve
 * them ourselves (see above) those bytes are our egress, not LinkedIn's, so
 * shrinking them matters more than it did.
 *
 * `cf.image` asks Cloudflare to transform on the fly. **It is a paid feature**
 * (Image Resizing / Images) and, as of 2026-08-07, it is NOT enabled on this
 * zone — `/cdn-cgi/image/...` answers 404. When it is off Cloudflare ignores
 * these options and returns the original, which is exactly today's behaviour,
 * so this is written to be a no-op until someone enables it in the dashboard.
 * No redeploy needed at that point — the bytes just get smaller.
 *
 * `fit: scale-down` never upscales, so a source smaller than the target is
 * passed through untouched rather than blown up.
 */
const DEFAULT_WIDTH = 640;
/** Discrete widths only — an open `w` fragments the cache and invites abuse. */
const ALLOWED_WIDTHS = new Set([320, 480, 640, 960, 1280]);
const RESIZE_QUALITY = 78;

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
  const params = new URL(request.url).searchParams;
  const raw = params.get("u");
  if (!raw) return new Response("missing ?u", { status: 400 });

  const asked = Number(params.get("w"));
  const width = ALLOWED_WIDTHS.has(asked) ? asked : DEFAULT_WIDTH;

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

  // Pick the output format ourselves rather than using `format: "auto"`, so the
  // cache key can name the format the response actually is. With "auto" the
  // bytes vary by Accept while the key does not, and an AVIF gets served to a
  // browser that asked for JPEG.
  const accept = request.headers.get("Accept") || "";
  const format = accept.includes("image/avif")
    ? "avif"
    : accept.includes("image/webp")
      ? "webp"
      : null;

  // Normalised key: two spellings of the same request (`?u=X` and `?u=X&w=640`
  // when 640 is the default) must not occupy two cache entries.
  const keyUrl = new URL(request.url);
  keyUrl.search =
    `?u=${encodeURIComponent(target.toString())}&w=${width}&f=${format || "orig"}`;
  const cache = caches.default;
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      // No Referer, no cookies — we want the bytes, not a session.
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: {
        cacheEverything: true,
        cacheTtl: 604800,
        // Ignored (returning the original) on a zone without Image Resizing.
        image: {
          width,
          quality: RESIZE_QUALITY,
          fit: "scale-down",
          ...(format ? { format } : {}),
        },
      },
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
      // The response format is negotiated from Accept, so shared caches in
      // front of us must not hand an AVIF to a client that cannot decode it.
      Vary: "Accept",
    },
  });

  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
