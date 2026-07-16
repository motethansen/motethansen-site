/**
 * motethansen-feed-refresh Worker
 *
 * Scheduled cron: fetches all Substack RSS feeds, merges in LinkedIn articles,
 * and writes the full merged list to KV so the website always has fresh content.
 *
 * Crons (wrangler.toml):
 *   "0 20 * * *"  — daily at 20:00 UTC
 *
 * Also handles GET /refresh for manual triggers (protected by REFRESH_SECRET).
 *
 * LinkedIn source:
 *   - Primary: KV key `linkedin-posts-v1` (JSON array), maintained by the
 *     external DigitalOcean sync job in linkedin-sync/.
 *   - Fallback: the in-repo seed array in content/linkedin-posts.js.
 *
 * GUARD: the cache is only overwritten when the rebuild is "healthy" (at least
 * one Substack feed loaded). A build where every Substack fetch failed is
 * returned to the caller but never written to KV, so a transient Substack
 * outage can no longer poison the feed with a LinkedIn-only snapshot.
 */

import { LINKEDIN_POSTS } from "../../content/linkedin-posts.js";

const CACHE_KEY = "writing-feed-v4";     // Must match functions/api/writing.js
const LINKEDIN_KEY = "linkedin-posts-v1";
// Backstop TTL — safely longer than the daily cron gap, so even an unexpected
// bad write self-heals instead of sticking forever (the old no-TTL failure mode).
const CACHE_TTL = 60 * 60 * 30;          // 30 hours

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

// ── Entry points ──────────────────────────────────────

export default {
  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFeeds(env));
  },

  // HTTP handler — GET /refresh?secret=xxx for manual trigger
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/refresh") {
      return new Response("motethansen feed-refresh worker\n", { status: 200 });
    }

    const secret = env.REFRESH_SECRET;
    if (secret && url.searchParams.get("secret") !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const { posts, healthy } = await refreshFeeds(env);
      return new Response(
        JSON.stringify({ ok: true, healthy, count: posts.length, posts }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

// ── Core refresh logic ────────────────────────────────

async function refreshFeeds(env) {
  console.log(`[feed-refresh] Starting refresh of ${SOURCES.length} feeds`);

  const results = await Promise.allSettled(SOURCES.map(fetchFeed));

  const posts = [];
  let healthy = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      healthy = true;
      console.log(`[feed-refresh] ${SOURCES[i].id}: ${r.value.length} posts`);
      posts.push(...r.value);
    } else {
      console.warn(`[feed-refresh] ${SOURCES[i].id} failed:`, r.reason?.message);
    }
  }

  // LinkedIn — from KV if the sync job has populated it, else the seed array.
  const linkedin = await getLinkedInPosts(env);
  for (const p of linkedin) {
    posts.push({
      title: p.title, url: p.url, date: p.date,
      image: p.image || null, description: p.description || "",
      source: "Michael Motet Hansen", platform: "LinkedIn",
      sourceLink: LINKEDIN_PROFILE_URL, sourceId: "linkedin",
    });
  }
  console.log(`[feed-refresh] linkedin: ${linkedin.length} posts`);

  // Sort newest-first, dedupe by URL. Store the FULL list — the Pages Function
  // slices it (top 9 for the homepage, all for the /writing/ page).
  posts.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const deduped = posts.filter(p => {
    if (!p.url || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  if (healthy) {
    await env.SITE_KV.put(CACHE_KEY, JSON.stringify(deduped), { expirationTtl: CACHE_TTL });
    console.log(`[feed-refresh] Wrote ${deduped.length} posts to KV key "${CACHE_KEY}"`);
  } else {
    console.warn(`[feed-refresh] All Substack feeds failed — skipping cache write to avoid poisoning`);
  }

  return { posts: deduped, healthy };
}

async function getLinkedInPosts(env) {
  try {
    const raw = await env.SITE_KV.get(LINKEDIN_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) {
    console.warn(`[feed-refresh] linkedin KV read failed:`, e?.message);
  }
  return LINKEDIN_POSTS;
}

// ── Feed fetching ─────────────────────────────────────

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    // Browser-like UA + no cf.cacheEverything — see functions/api/writing.js.
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml, source);
}

// ── RSS parser ────────────────────────────────────────

function parseRSS(xml, source) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return items.slice(0, 5).map(m => parseItem(m[1], source)).filter(Boolean);
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

  return {
    title, url, date, image, description: desc,
    source: source.name, platform: source.platform,
    sourceLink: source.link, sourceId: source.id,
  };
}

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
  const g  = item.match(/<guid[^>]*>([^<]+)<\/guid>/i);
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
