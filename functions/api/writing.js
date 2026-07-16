/**
 * GET /api/writing
 * Aggregates live Substack RSS feeds plus LinkedIn articles.
 *
 * LinkedIn source:
 *   - Primary: KV key `linkedin-posts-v1` (a JSON array), maintained by the
 *     external DigitalOcean sync job in linkedin-sync/. Lets new LinkedIn
 *     articles appear with no redeploy.
 *   - Fallback: the in-repo seed array in content/linkedin-posts.js (used when
 *     the KV key is missing/empty, e.g. before the sync job has run).
 *
 * Response: { posts, total, cached }
 *   - default: top 9 posts (homepage grid)
 *   - ?all=1 : the full merged list (the /writing/ articles page)
 *
 * Caching (SITE_KV):
 *   - The FULL merged list is cached under `writing-feed-v4` for 6h.
 *   - GUARD: a rebuild is only written to the cache when it is "healthy"
 *     (at least one Substack feed fetched successfully). A build where every
 *     Substack fetch failed is served but never persisted, so a transient
 *     Substack outage can no longer poison the cache with a LinkedIn-only feed.
 */

import { LINKEDIN_POSTS } from "../../content/linkedin-posts.js";

const CACHE_KEY = "writing-feed-v4";
const LINKEDIN_KEY = "linkedin-posts-v1";
const CACHE_TTL = 60 * 60 * 6; // 6 hours
const HOME_LIMIT = 9;

const LINKEDIN_PROFILE_URL = "https://www.linkedin.com/in/michaelmotethansen/recent-activity/articles/";

const SOURCES = [
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

export async function onRequestGet({ request, env }) {
  const wantAll = new URL(request.url).searchParams.get("all") === "1";

  // 1. Serve the cached full list if present.
  if (env.SITE_KV) {
    const cached = await kvGetJson(env, CACHE_KEY);
    if (Array.isArray(cached)) return feedResponse(cached, wantAll, true);
  }

  // 2. Rebuild from live sources.
  const { posts, healthy } = await buildFeed(env);

  // 3. Only persist a healthy build — never cache a Substack-less feed.
  if (env.SITE_KV && healthy) {
    try {
      await env.SITE_KV.put(CACHE_KEY, JSON.stringify(posts), { expirationTtl: CACHE_TTL });
    } catch {}
  }

  return feedResponse(posts, wantAll, false);
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// ── Feed assembly ─────────────────────────────────────

/**
 * Fetch every Substack feed + LinkedIn, merge, sort, dedupe.
 * Returns { posts: <full list>, healthy: <at least one Substack feed loaded> }.
 */
async function buildFeed(env) {
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));

  const posts = [];
  let healthy = false;
  for (const r of results) {
    if (r.status === "fulfilled") {
      healthy = true; // a feed responded (even an empty one is a real answer)
      posts.push(...r.value);
    } else {
      console.warn("Feed failed:", r.reason?.message);
    }
  }

  // LinkedIn — from KV if the sync job has populated it, else the seed array.
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

  return { posts: deduped, healthy };
}

async function getLinkedInPosts(env) {
  if (env.SITE_KV) {
    const stored = await kvGetJson(env, LINKEDIN_KEY);
    if (Array.isArray(stored) && stored.length) return stored;
  }
  return LINKEDIN_POSTS;
}

function feedResponse(fullPosts, wantAll, cached) {
  const posts = wantAll ? fullPosts : fullPosts.slice(0, HOME_LIMIT);
  return jsonResponse({ posts, total: fullPosts.length, cached });
}

// ── Feed fetching ─────────────────────────────────────

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    // Browser-like UA + no cf.cacheEverything: Substack blocks bot-ish requests
    // from Cloudflare egress, and cacheEverything can pin that block response at
    // the edge. KV is our cache layer, so no edge subrequest caching is needed.
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${source.id}`);
  const xml = await res.text();
  return parseRSS(xml, source);
}

// ── RSS parser ────────────────────────────────────────

function parseRSS(xml, source) {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return itemMatches.slice(0, 5).map(m => parseItem(m[1], source)).filter(Boolean);
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
  return /\.(jpe?g|png|webp|gif|avif)/i.test(url)
    || url.includes("substackcdn");
}

function stripHtml(html) {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function kvGetJson(env, key) {
  try {
    const raw = await env.SITE_KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json",
               "Cache-Control": "public, max-age=3600", ...corsHeaders() },
  });
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}
