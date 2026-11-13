/** Image upload to R2 and serving. Only png/jpeg/webp/gif, checked by magic bytes, max 5 MB. No SVG (it can carry script). */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MEDIA_PATH = /^\/media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

function sniff(b) {
  const ascii = (o, s) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length > 8 && b[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && ascii(0, "GIF8")) return "image/gif";
  if (b.length > 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** @returns {Promise<{status:number, body:object}>} */
export async function uploadImage(env, request, now = new Date()) {
  const declared = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!TYPES[declared]) return { status: 415, body: { error: "Only PNG, JPEG, WebP or GIF images are accepted." } };
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) return { status: 413, body: { error: "Images are limited to 5 MB." } };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return { status: 413, body: { error: "Images are limited to 5 MB." } };
  if (!bytes.length || sniff(bytes) !== declared) {
    return { status: 415, body: { error: "That file is not the image type it claims to be." } };
  }
  const key = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${TYPES[declared]}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: declared } });
  return { status: 201, body: { key, url: "/" + key } };
}

/**
 * Import an image that a pasted article points at (LinkedIn / Substack CDNs) into our own storage, so the article
 * keeps its pictures if the original is deleted. SSRF-safe: https only, no credentials in the URL, exact host
 * allowlist, no redirects, size cap, and the bytes must really be a supported image.
 */
export const IMPORT_HOSTS = [/^media(?:-exp\d+)?\.licdn\.com$/, /^substackcdn\.com$/, /^substack-post-media\.s3\.amazonaws\.com$/, /^bucketeer-[a-z0-9-]+\.s3\.amazonaws\.com$/];

export function importAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  return IMPORT_HOSTS.some(re => re.test(u.hostname)) ? u : null;
}

export async function importImage(env, rawUrl, fetcher = fetch, now = new Date()) {
  const u = importAllowed(rawUrl);
  if (!u) return { status: 400, body: { error: "Images can only be imported from LinkedIn or Substack addresses." } };
  let res;
  try {
    res = await fetcher(u.toString(), { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; article-import)", Accept: "image/*" } });
  } catch {
    return { status: 502, body: { error: "Could not download that image." } };
  }
  if (!res.ok) return { status: 502, body: { error: `The image host answered ${res.status}.` } };
  if (Number(res.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return { status: 413, body: { error: "Images are limited to 5 MB." } };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return { status: 413, body: { error: "Images are limited to 5 MB." } };
  const type = sniff(bytes);
  if (!type) return { status: 415, body: { error: "That address is not a PNG, JPEG, WebP or GIF image." } };
  const key = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${TYPES[type]}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
  return { status: 201, body: { key, url: "/" + key } };
}

export async function serveImage(env, pathname, method = "GET") {
  if (!MEDIA_PATH.test(pathname)) return new Response("Not found", { status: 404 });
  const obj = await env.MEDIA.get(pathname.slice(1));
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(method === "HEAD" ? null : obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}
