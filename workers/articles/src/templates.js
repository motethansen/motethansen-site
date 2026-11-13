/** Server-rendered public pages for motethansen.com: article page, RSS and the JSON list. */
import { SITES } from "./sites.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const iso = s => new Date(s * 1000).toISOString();
const dateLong = s => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const articleUrl = (site, a) => a.external_url || `${SITES[site].origin}/writing/${a.slug}/`;
const absolute = (site, p) => (p && p.startsWith("/") ? SITES[site].origin + p : p || "");

import { LAYOUTS } from "./layouts.js";

function shell(site, { title, description, canonical, head = "", body, bodyClass = "" }) {
  const L = LAYOUTS[site];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="author" content="${esc(SITES[site].name)}">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="alternate" type="application/rss+xml" title="Writing" href="/writing/rss.xml">
  ${head}
  ${L.headExtra}
  ${L.css ? `<style>${L.css}</style>` : ""}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
  ${L.bodyOpen}
  ${body}
  ${L.bodyClose(new Date().getUTCFullYear())}
</body>
</html>`;
}

export function articlePage(site, a, bodyHtml) {
  const url = articleUrl(site, a);
  const cover = absolute(site, a.cover);
  const published = a.published_at || a.created_at;
  const ld = {
    "@context": "https://schema.org", "@type": "Article", headline: a.title, description: a.description || undefined,
    datePublished: iso(published), dateModified: iso(a.updated_at), image: cover || undefined,
    author: { "@type": "Person", name: "Michael Motet Hansen" }, publisher: { "@type": "Organization", name: SITES[site].name, url: SITES[site].origin },
    mainEntityOfPage: url,
  };
  const head = `<meta property="og:type" content="article">
  <meta property="og:title" content="${esc(a.title)}">
  <meta property="og:description" content="${esc(a.description)}">
  <meta property="og:url" content="${esc(url)}">
  ${cover ? `<meta property="og:image" content="${esc(cover)}">` : ""}
  <meta property="article:published_time" content="${iso(published)}">
  <meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">
  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
  const body = `<article class="article">
          <p class="eyebrow"><a href="/writing/" style="text-decoration:none;color:inherit">← All articles</a></p>
          <h1 class="section__title">${esc(a.title)}</h1>
          <p class="article__meta"><time datetime="${iso(published)}">${dateLong(published)}</time></p>
          ${a.cover ? `<img class="article__cover" src="${esc(a.cover)}" alt="" decoding="async">` : ""}
          <div class="article__body">${bodyHtml}</div>
          ${a.tags.length ? `<p class="article__tags">${a.tags.map(t => `#${esc(t)}`).join(" ")}</p>` : ""}
        </article>`;
  return shell(site, { title: `${a.title} — ${SITES[site].name}`, description: a.description, canonical: url, head, body });
}

/**
 * Server-rendered archive page (vizneo.com; motethansen.com keeps its static /writing/ page).
 * `cards` = [{ a: article row, image: url|null, brief: string }]. Every card carries what a reader needs to decide:
 * the cover (when there is one), the title, a short brief and a plain "read" link; the newest card with a cover is featured.
 */
export function listPage(site, cards) {
  const url = `${SITES[site].origin}/writing/`;
  const featuredAt = cards.findIndex(c => c.image);
  const items = cards.map((c, i) => {
    const a = c.a, href = esc(articleUrl(site, a)), out = !!a.external_url;
    const link = out ? ' target="_blank" rel="noopener"' : "";
    const meta = [dateLong(a.published_at || a.created_at), out ? a.source : ""].filter(Boolean).map(esc).join(" · ");
    return `<li class="card${i === featuredAt ? " card--featured" : ""}${c.image ? "" : " card--plain"}">
      ${c.image ? `<a class="card__media" href="${href}"${link} tabindex="-1" aria-hidden="true"><img src="${esc(c.image)}" alt="" loading="${i < 3 ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer"></a>` : ""}
      <div class="card__body">
        <p class="card__meta">${meta}</p>
        <h2 class="card__title"><a href="${href}"${link}>${esc(a.title)}</a></h2>
        ${c.brief ? `<p class="card__brief">${esc(c.brief)}</p>` : ""}
        <a class="card__cta" href="${href}"${link}>${out ? `Read on ${esc(a.platform)}` : "Read the full article"} <span aria-hidden="true">→</span></a>
      </div>
    </li>`;
  }).join("");
  const body = `<p class="eyebrow">Writing</p><h1>Articles.</h1>
    ${cards.length ? `<ul class="cards">${items}</ul>` : `<p>Nothing published yet.</p>`}`;
  return shell(site, { title: `Writing — ${SITES[site].name}`, description: `Articles from ${SITES[site].name}.`, canonical: url, body, bodyClass: "list-page" });
}

/** Entry shape shared with the Substack posts the /writing page already lists. */
export function feedEntry(site, a) {
  return {
    title: a.title, url: articleUrl(site, a), date: iso(a.published_at || a.created_at),
    image: absolute(site, a.cover) || null, description: a.description,
    source: a.source || SITES[site].name, platform: a.platform || SITES[site].host,
    sourceLink: a.external_url ? "" : `${SITES[site].origin}/writing/`, sourceId: a.external_url ? "external" : "native",
    slug: a.slug, tags: a.tags,
  };
}

export function rssFeed(site, articles, renderedBodies) {
  const s = SITES[site];
  const items = articles.map((a, i) => `
    <item>
      <title>${esc(a.title)}</title>
      <link>${esc(articleUrl(site, a))}</link>
      <guid isPermaLink="true">${esc(articleUrl(site, a))}</guid>
      <pubDate>${new Date((a.published_at || a.created_at) * 1000).toUTCString()}</pubDate>
      <description>${esc(a.description)}</description>
      <content:encoded><![CDATA[${String(renderedBodies[i]).replace(/]]>/g, "]]]]><![CDATA[>")}]]></content:encoded>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(s.name)} — Writing</title>
    <link>${esc(s.origin)}/writing/</link>
    <atom:link href="${esc(s.origin)}/writing/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Essays and notes by ${esc(s.name)}.</description>
    <language>en</language>${items}
  </channel>
</rss>`;
}
