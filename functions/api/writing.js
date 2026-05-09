const FEEDS = [
  { source: "substack", url: "https://urbanlifeworks.substack.com/feed" },
  { source: "medium", url: "https://medium.com/feed/@motethansen" },
];

const CACHE_KEY = "writing-feed";
const CACHE_TTL_SECONDS = 21600;
const MAX_ITEMS = 10;
const EXCERPT_MAX = 200;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      ...CORS_HEADERS,
    },
  });
}

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&amp;/g, "&");
}

function stripCdata(str) {
  if (!str) return "";
  const m = str.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : str;
}

function extractTag(itemXml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = itemXml.match(re);
  if (!match) return "";
  return decodeEntities(stripCdata(match[1])).trim();
}

function stripHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd();
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseRss(xml, source) {
  const items = [];
  if (!xml) return items;
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const pubDateRaw = extractTag(itemXml, "pubDate");
    const description = extractTag(itemXml, "description");

    if (!title && !link) continue;

    const date = parseDate(pubDateRaw);
    const excerpt = truncate(stripHtml(description), EXCERPT_MAX);

    items.push({
      title,
      url: link,
      date: date ? date.toISOString() : null,
      excerpt,
      source,
    });
  }
  return items;
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8",
      "User-Agent": "motethansen-site/1.0 (+https://motethansen.com)",
    },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`${feed.source} responded ${res.status}`);
  const xml = await res.text();
  return parseRss(xml, feed.source);
}

function sortByDateDesc(a, b) {
  const at = a.date ? Date.parse(a.date) : 0;
  const bt = b.date ? Date.parse(b.date) : 0;
  return bt - at;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const kv = env && env.SITE_KV;

  try {
    if (kv) {
      const cached = await kv.get(CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return jsonResponse({
            posts: parsed.posts || [],
            cached: true,
            updated: parsed.updated,
          });
        } catch (_) {
          // fall through
        }
      }
    }

    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const posts = [];
    for (const result of results) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        posts.push(...result.value);
      }
    }

    posts.sort(sortByDateDesc);
    const top = posts.slice(0, MAX_ITEMS);
    const updated = new Date().toISOString();

    if (kv && top.length > 0) {
      try {
        await kv.put(
          CACHE_KEY,
          JSON.stringify({ posts: top, updated }),
          { expirationTtl: CACHE_TTL_SECONDS },
        );
      } catch (_) {
        // ignore cache failures
      }
    }

    return jsonResponse({ posts: top, cached: false, updated });
  } catch (_) {
    return jsonResponse({ posts: [], cached: false, updated: new Date().toISOString() }, 200);
  }
}
