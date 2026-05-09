const ORCID_ID = "0000-0001-7645-5958";
const ORCID_URL = `https://pub.orcid.org/v3.0/${ORCID_ID}/works`;
const CACHE_KEY = "publications";
const CACHE_TTL_SECONDS = 86400;
const MAX_ITEMS = 20;

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
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  });
}

function errorPayload() {
  return { error: "unavailable", publications: [] };
}

function extractDoi(externalIds) {
  const ids = externalIds && externalIds["external-id"];
  if (!Array.isArray(ids)) return null;
  for (const entry of ids) {
    if (entry && entry["external-id-type"] === "doi") {
      const value = entry["external-id-value"];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

function normalizeWork(group) {
  const summaries = group && group["work-summary"];
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const summary = summaries[0];
  if (!summary) return null;

  const title =
    summary.title && summary.title.title && summary.title.title.value
      ? summary.title.title.value
      : null;
  if (!title) return null;

  const year =
    summary["publication-date"] &&
    summary["publication-date"].year &&
    summary["publication-date"].year.value
      ? summary["publication-date"].year.value
      : null;

  const doi = extractDoi(summary["external-ids"]);
  const journal =
    summary["journal-title"] && summary["journal-title"].value
      ? summary["journal-title"].value
      : null;
  const type = summary.type || null;
  const url = doi ? `https://doi.org/${doi}` : null;

  return { title, year, doi, journal, type, url };
}

function sortByYearDesc(a, b) {
  const ay = parseInt(a.year, 10);
  const by = parseInt(b.year, 10);
  const aValid = Number.isFinite(ay);
  const bValid = Number.isFinite(by);
  if (aValid && bValid) return by - ay;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

async function fetchFromOrcid() {
  const res = await fetch(ORCID_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ORCID responded ${res.status}`);
  const data = await res.json();
  const groups = Array.isArray(data && data.group) ? data.group : [];
  const works = groups.map(normalizeWork).filter(Boolean);
  works.sort(sortByYearDesc);
  return works.slice(0, MAX_ITEMS);
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
            publications: parsed.publications || [],
            cached: true,
            updated: parsed.updated,
          });
        } catch (_) {
          // fall through to refetch
        }
      }
    }

    const publications = await fetchFromOrcid();
    const updated = new Date().toISOString();
    const payload = { publications, updated };

    if (kv) {
      try {
        await kv.put(CACHE_KEY, JSON.stringify(payload), {
          expirationTtl: CACHE_TTL_SECONDS,
        });
      } catch (_) {
        // cache write failure should not break the response
      }
    }

    return jsonResponse({ publications, cached: false, updated });
  } catch (_) {
    return jsonResponse(errorPayload(), 200);
  }
}
