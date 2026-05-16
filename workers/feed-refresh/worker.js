/**
 * motethansen-feed-refresh Worker
 *
 * Scheduled cron: fetches all RSS feeds, parses posts with images,
 * and writes the result to KV so the website always shows fresh content.
 *
 * Crons (wrangler.toml):
 *   "0 20 * * *"  — daily at 20:00 UTC
 *
 * Also handles GET /refresh for manual triggers (protected by REFRESH_SECRET).
 */

const CACHE_KEY = "writing-feed-v3";   // Must match functions/api/writing.js
const MAX_POSTS  = 9;

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
  {
    id: "ulw-medium",
    name: "Urban Life Works",
    platform: "Medium",
    feed: "https://medium.com/feed/urban-life-works",
    link: "https://medium.com/urban-life-works",
  },
  {
    id: "va-medium",
    name: "Vizneo Academy",
    platform: "Medium",
    feed: "https://medium.com/feed/vizneo-academy",
    link: "https://medium.com/vizneo-academy",
  },
  // { id: "personal-medium", name: "Michael Motet Hansen", platform: "Medium", feed: "https://medium.com/feed/@motethansen", link: "https://motethansen.medium.com" }, // disabled — duplicates publication feeds
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
      const posts = await refreshFeeds(env);
      return new Response(
        JSON.stringify({ ok: true, count: posts.length, posts }, null, 2),
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
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      console.log(`[feed-refresh] ${SOURCES[i].id}: ${r.value.length} posts`);
      posts.push(...r.value);
    } else {
      console.warn(`[feed-refresh] ${SOURCES[i].id} failed:`, r.reason?.message);
    }
  }

  // Sort newest-first, deduplicate, cap at MAX_POSTS
  posts.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const top = posts.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  }).slice(0, MAX_POSTS);

  // Write to KV — no TTL so it never expires between cron runs
  await env.SITE_KV.put(CACHE_KEY, JSON.stringify(top));
  console.log(`[feed-refresh] Wrote ${top.length} posts to KV key "${CACHE_KEY}"`);

  return top;
}

// ── Feed fetching ─────────────────────────────────────

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    headers: { "User-Agent": "motethansen.com/1.0 feed-refresh-worker" },
    cf: { cacheTtl: 900, cacheEverything: true },
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
    || url.includes("substackcdn")
    || url.includes("miro.medium")
    || url.includes("cdn-images");
}

function stripHtml(html) {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim();
}
