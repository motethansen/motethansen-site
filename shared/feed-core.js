/**
 * Shared feed core — used by BOTH functions/api/writing.js (Pages Function)
 * and workers/feed-refresh/worker.js (scheduled Worker).
 *
 * This module exists because those two entry points previously carried
 * byte-identical copies of the fetch/parse/merge logic behind "keep in sync"
 * comments — and they drifted (the per-feed item cap was fixed in one place
 * only). One copy, two importers.
 *
 * ── Resilience model ─────────────────────────────────────────────────────
 * Substack intermittently blocks requests coming from Cloudflare's egress
 * network. That failure is PER PUBLICATION, not global: one feed can 403 or
 * return a challenge page while the other sails through.
 *
 * The old guard only asked "did at least one feed load?" — so a build where
 * Urban Life Works was blocked but Vizneo Academy succeeded counted as
 * healthy, was written to KV, and served a silently-incomplete feed for the
 * full cache lifetime. That is exactly the "Substack articles disappeared"
 * symptom.
 *
 * So each source now keeps its own last-known-good snapshot in KV:
 *   - fetch succeeds with >0 items  → serve live, refresh that source's snapshot
 *   - fetch fails, or parses to 0 items (a challenge/error page) → serve the
 *     source's snapshot instead of silently dropping it
 *   - no snapshot either            → the build is INCOMPLETE and is never cached
 *
 * A build is only written to the merged cache when every source contributed
 * posts. Builds that leaned on a snapshot get a short TTL so the next request
 * retries upstream soon instead of coasting for 30h.
 */

import { LINKEDIN_POSTS } from "../content/linkedin-posts.js";

export const CACHE_KEY = "writing-feed-v4";
export const LINKEDIN_KEY = "linkedin-posts-v1";

/** Per-source last-known-good snapshot: `feed-src-v1:<sourceId>`. */
export const SOURCE_CACHE_PREFIX = "feed-src-v1:";
/**
 * Snapshots outlive any plausible transient block. If a source stays blocked
 * for longer than this the snapshot expires, builds go incomplete, and we stop
 * caching rather than quietly serving a feed that is missing a publication.
 */
export const SOURCE_CACHE_TTL = 60 * 60 * 24 * 14; // 14 days

/** Merged-cache TTL when every source was fetched live. */
export const CACHE_TTL = 60 * 60 * 6; // 6 hours
/** Merged-cache TTL when any source came from a snapshot — retry upstream sooner. */
export const CACHE_TTL_DEGRADED = 60 * 30; // 30 minutes

/**
 * Per-feed safety bound. Substack serves a publication's whole archive in its
 * RSS feed, so this must stay well above the post count or imported
 * back-catalogue articles get silently truncated (they carry their original,
 * older dates and so sort below the cut).
 */
export const MAX_ITEMS_PER_FEED = 100;

export const LINKEDIN_PROFILE_URL =
  "https://www.linkedin.com/in/michaelmotethansen/recent-activity/articles/";

export const SOURCES = [
  {
    id: "ulw-substack",
    name: "Urban Life Works",
    platform: "Substack",
    feed: "https://urbanlifeworks.substack.com/feed",
    link: "https://urbanlifeworks.substack.com/",
  },
  {
    id: "va-substack",
    name: "Vizneo Academy",
    platform: "Substack",
    feed: "https://vizneoacademy.substack.com/feed",
    link: "https://vizneoacademy.substack.com/",
  },
];

// ── Feed assembly ─────────────────────────────────────

/**
 * Fetch every Substack feed (with per-source fallback) + LinkedIn, merge,
 * sort newest-first, dedupe by URL.
 *
 * @returns {Promise<{
 *   posts: Array, complete: boolean, degraded: boolean, sources: Array
 * }>}
 *   posts    — the full merged list
 *   complete — every source contributed at least one post (safe to cache)
 *   degraded — at least one source was served from its snapshot, not live
 *   sources  — per-source diagnostics: { id, status, count, error }
 */
export async function buildFeed(env) {
  const loaded = await Promise.all(SOURCES.map(s => loadSource(env, s)));

  const posts = [];
  let complete = true;
  let degraded = false;

  for (const r of loaded) {
    if (r.status === "live") {
      // nothing to flag
    } else if (r.status === "snapshot") {
      degraded = true;
      console.warn(`[feed] ${r.id}: upstream failed (${r.error}) — served ${r.count} from snapshot`);
    } else {
      complete = false;
      console.error(`[feed] ${r.id}: upstream failed (${r.error}) and no snapshot — feed is INCOMPLETE`);
    }
    posts.push(...r.posts);
  }

  // LinkedIn — from KV if the sync job has populated it, else the in-repo seed.
  for (const p of await getLinkedInPosts(env)) {
    posts.push({
      title: p.title, url: p.url, date: p.date,
      image: p.image || null, description: p.description || "",
      source: "Michael Motet Hansen", platform: "LinkedIn",
      sourceLink: LINKEDIN_PROFILE_URL, sourceId: "linkedin",
    });
  }

  posts.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const deduped = posts.filter(p => {
    if (!p.url || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  return {
    posts: deduped,
    complete,
    degraded,
    sources: loaded.map(({ id, status, count, error }) => ({ id, status, count, error })),
  };
}

/**
 * Load one source: live fetch first, then that source's KV snapshot.
 * Status is "live" | "snapshot" | "missing".
 */
async function loadSource(env, source) {
  let error = null;
  try {
    const posts = await fetchFeed(source);
    // A real Substack feed always has items. Zero parsed items means we got
    // something that wasn't the feed (challenge page, error page, empty body),
    // so treat it as a failure rather than caching an empty publication.
    if (posts.length) {
      await putSnapshot(env, source.id, posts);
      return { id: source.id, status: "live", count: posts.length, error: null, posts };
    }
    error = "0 items parsed";
  } catch (e) {
    error = e?.message || String(e);
  }

  const snapshot = await getSnapshot(env, source.id);
  if (snapshot?.length) {
    return { id: source.id, status: "snapshot", count: snapshot.length, error, posts: snapshot };
  }
  return { id: source.id, status: "missing", count: 0, error, posts: [] };
}

/** Write the merged list to KV, but only when it is complete. */
export async function cacheFeed(env, build) {
  if (!env?.SITE_KV) return false;
  if (!build.complete) return false;
  const ttl = build.degraded ? CACHE_TTL_DEGRADED : CACHE_TTL;
  try {
    await env.SITE_KV.put(CACHE_KEY, JSON.stringify(build.posts), { expirationTtl: ttl });
    return true;
  } catch (e) {
    console.warn("[feed] cache write failed:", e?.message);
    return false;
  }
}

// ── KV helpers ────────────────────────────────────────

async function getSnapshot(env, sourceId) {
  if (!env?.SITE_KV) return null;
  const arr = await kvGetJson(env, SOURCE_CACHE_PREFIX + sourceId);
  return Array.isArray(arr) ? arr : null;
}

async function putSnapshot(env, sourceId, posts) {
  if (!env?.SITE_KV) return;
  try {
    await env.SITE_KV.put(SOURCE_CACHE_PREFIX + sourceId, JSON.stringify(posts), {
      expirationTtl: SOURCE_CACHE_TTL,
    });
  } catch (e) {
    console.warn(`[feed] snapshot write failed for ${sourceId}:`, e?.message);
  }
}

export async function getLinkedInPosts(env) {
  if (env?.SITE_KV) {
    const stored = await kvGetJson(env, LINKEDIN_KEY);
    if (Array.isArray(stored) && stored.length) return stored;
  }
  return LINKEDIN_POSTS;
}

export async function kvGetJson(env, key) {
  try {
    const raw = await env.SITE_KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Feed fetching ─────────────────────────────────────

/**
 * Fetch + parse one RSS feed.
 *
 * Browser-like UA and no `cf: { cacheEverything }`: Substack blocks bot-ish
 * requests from Cloudflare egress, and cacheEverything can pin that block
 * response at the edge. KV is our cache layer — no edge subrequest caching.
 *
 * One retry, because these blocks are frequently transient.
 */
export async function fetchFeed(source, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(source.feed, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${source.id}`);
      return parseRSS(await res.text(), source);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── RSS parser ────────────────────────────────────────

export function parseRSS(xml, source) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, MAX_ITEMS_PER_FEED)
    .map(m => parseItem(m[1], source))
    .filter(Boolean);
}

function parseItem(item, source) {
  const title = stripHtml(extractTag(item, "title"));
  const url   = extractUrl(item);
  const date  = extractTag(item, "pubDate") || extractTag(item, "dc:date") || "";
  const image = extractImage(item);
  const desc  = stripHtml(
    extractTag(item, "content:encoded") || extractTag(item, "description") || ""
  ).slice(0, 180).trim();

  if (!title || !url) return null;
  // Substack auto-creates a "/p/coming-soon" welcome stub per publication.
  if (/\/p\/coming-soon\/?$/i.test(url)) return null;

  return { title, url, date, image, description: desc,
           source: source.name, platform: source.platform,
           sourceLink: source.link, sourceId: source.id };
}

// ── XML helpers ───────────────────────────────────────

function extractTag(xml, tag) {
  const cd = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"));
  if (cd) return cd[1].trim();
  const pl = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return pl ? pl[1].trim() : "";
}

function extractUrl(item) {
  const lc = item.match(/<link>\s*<!\[CDATA\[(.*?)\]\]>/i);
  if (lc) return lc[1].trim();
  const lp = item.match(/<link>([^<\s][^<]*)<\/link>/i);
  if (lp) return lp[1].trim();
  const g = item.match(/<guid[^>]*>([^<]+)<\/guid>/i);
  if (g && g[1].startsWith("http")) return g[1].trim();
  return "";
}

function extractImage(item) {
  const mc = item.match(/<media:content[^>]+url="([^"]+)"/i);
  if (mc && isImage(mc[1])) return mc[1];
  const en = item.match(/<enclosure[^>]+url="([^"]+)"/i);
  if (en && isImage(en[1])) return en[1];
  const content = extractTag(item, "content:encoded") || extractTag(item, "description");
  const img = content.match(/<img[^>]+src="([^"]+)"/i);
  if (img && isImage(img[1]) && !img[1].includes("emoji") && !img[1].includes("stat.")) {
    return img[1];
  }
  return null;
}

function isImage(url) {
  return /\.(jpe?g|png|webp|gif|avif)/i.test(url) || url.includes("substackcdn");
}

function stripHtml(html) {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim();
}
