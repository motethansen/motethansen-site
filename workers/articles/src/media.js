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
