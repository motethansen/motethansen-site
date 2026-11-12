/**
 * Pure helpers for the /admin page (WebCrypto only, so they run in Pages Functions and under node --test).
 *
 *   - constant-time credential comparison
 *   - HMAC-signed session tokens (no server-side session store)
 *   - login throttling decision
 *   - LinkedIn article address validation (same rules as linkedin-sync/tools/handoff_urls.py)
 */

export const SESSION_COOKIE = "admin_session";
export const SESSION_TTL_S = 12 * 3600;
export const THROTTLE_MAX_FAILS = 5;
export const THROTTLE_WINDOW_S = 15 * 60;

const enc = new TextEncoder();

const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

/** Compare two strings without leaking length or the first differing byte. */
export async function timingSafeEqualStr(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/** True only when BOTH username and password match, evaluating both so timing does not say which was wrong. */
export async function checkCredentials(env, username, password) {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return false;   // not configured: nobody gets in
  const [u, p] = await Promise.all([
    timingSafeEqualStr(username ?? "", env.ADMIN_USER),
    timingSafeEqualStr(password ?? "", env.ADMIN_PASSWORD),
  ]);
  return u && p;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(secret, user, nowS, ttlS = SESSION_TTL_S) {
  const payload = b64u(enc.encode(JSON.stringify({ u: user, exp: nowS + ttlS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64u(sig)}`;
}

/** @returns {Promise<{u:string,exp:number}|null>} */
export async function verifySession(secret, token, nowS) {
  if (!secret || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64u(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    return data && typeof data.exp === "number" && data.exp > nowS ? data : null;
  } catch {
    return null;
  }
}

/**
 * Throttle record: { fails: n, first: epochS }.  Locked once THROTTLE_MAX_FAILS failures fall inside
 * THROTTLE_WINDOW_S; the lock lifts when the window since the first failure has passed.
 */
export function throttleState(record, nowS) {
  if (!record || nowS - record.first >= THROTTLE_WINDOW_S) return { locked: false, record: null };
  return { locked: record.fails >= THROTTLE_MAX_FAILS, retryAfterS: record.first + THROTTLE_WINDOW_S - nowS, record };
}

export function recordFailure(record, nowS) {
  const live = record && nowS - record.first < THROTTLE_WINDOW_S ? record : null;
  return { fails: (live?.fails || 0) + 1, first: live?.first || nowS };
}

const ARTICLE_RE = /^https:\/\/www\.linkedin\.com\/pulse\/([A-Za-z0-9-]{3,300})$/;

/** Normalise and validate a LinkedIn article address. Throws Error(message) when it is not one. */
export function validateArticleUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error("That is not a web address."); }
  if (u.protocol !== "https:") throw new Error("The address must start with https://");
  if (u.hostname !== "www.linkedin.com" || u.port) throw new Error("The address must be on www.linkedin.com");
  const clean = `https://${u.hostname}${u.pathname.replace(/\/+$/, "")}`;   // drops ?query, #fragment, trailing /
  if (!ARTICLE_RE.test(clean)) throw new Error("Expected an article address like https://www.linkedin.com/pulse/your-article-slug");
  return clean;
}

export const slugOf = url => (url.match(/\/pulse\/([^/?#]+)/i) || [])[1]?.toLowerCase() || "";
