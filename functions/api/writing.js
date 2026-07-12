/**
 * GET /api/writing
 * Aggregates RSS feeds from Substack publications plus manually maintained
 * LinkedIn articles (see content/linkedin-posts.js).
 * Returns top 9 posts sorted by date desc, with images.
 * Cached in KV for 6 hours if SITE_KV binding is configured.
 */

import { LINKEDIN_POSTS } from "../../content/linkedin-posts.js";

const CACHE_KEY = "writing-feed-v3";
const CACHE_TTL = 60 * 60 * 6; // 6 hours

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

export async function onRequestGet({ env }) {
  // Try KV cache first
  if (env.SITE_KV) {
    try {
      const cached = await env.SITE_KV.get(CACHE_KEY);
      if (cached) return jsonResponse({ posts: JSON.parse(cached), cached: true });
    } catch {}
  }

  // Fetch all feeds in parallel, tolerate individual failures
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));

  const posts = [];
  for (const r of results) {
    if (r.status === "fulfilled") posts.push(...r.value);
    else console.warn("Feed failed:", r.reason?.message);
  }

  // Add manually maintained LinkedIn articles
  for (const p of LINKEDIN_POSTS) {
    posts.push({
      title: p.title, url: p.url, date: p.date,
      image: p.image || null, description: p.description || "",
      source: "Michael Motet Hansen", platform: "LinkedIn",
      sourceLink: LINKEDIN_PROFILE_URL, sourceId: "linkedin",
    });
  }

  // Sort newest first, deduplicate by URL, take top 9
  posts.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const top = posts.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  }).slice(0, 9);

  // Write to KV cache
  if (env.SITE_KV) {
    try {
      await env.SITE_KV.put(CACHE_KEY, JSON.stringify(top), { expirationTtl: CACHE_TTL });
    } catch {}
  }

  return jsonResponse({ posts: top });
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// ── Feed fetching ─────────────────────────────────────

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    headers: { "User-Agent": "motethansen.com/1.0 RSS aggregator" },
    cf: { cacheTtl: 3600, cacheEverything: true },
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
