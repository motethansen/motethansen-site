/** Server-rendered public pages for motethansen.com: article page, RSS and the JSON list. */
import { SITES } from "./sites.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const iso = s => new Date(s * 1000).toISOString();
const dateLong = s => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const articleUrl = (site, a) => `${SITES[site].origin}/writing/${a.slug}/`;
const absolute = (site, p) => (p && p.startsWith("/") ? SITES[site].origin + p : p || "");

const ARTICLE_CSS = `
.article{max-width:720px;margin:0 auto}
.article__meta{color:var(--color-text-soft);margin:.4rem 0 1.6rem;font-size:.95rem}
.article__cover{width:100%;height:auto;border-radius:var(--radius);margin:0 0 2rem}
.article__body{font-size:1.08rem;line-height:1.75}
.article__body h2{margin:2.2rem 0 .8rem;font-size:1.5rem}
.article__body h3{margin:1.8rem 0 .6rem;font-size:1.2rem}
.article__body img{max-width:100%;height:auto;border-radius:8px}
.article__body blockquote{margin:1.4rem 0;padding:.2rem 1.2rem;border-left:3px solid var(--color-accent);color:var(--color-text-muted)}
.article__body pre{overflow-x:auto;padding:1rem;background:var(--color-bg-alt);border-radius:8px}
.article__body code{font-size:.92em}
.article__body a{color:var(--color-accent)}
.article__tags{margin-top:2.4rem;color:var(--color-text-soft);font-size:.9rem}
`;

const HEADER = `<a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <nav class="nav" aria-label="Primary">
      <a class="nav__brand" href="/">
        <img class="nav__mark" src="/assets/img/logo-smartcity.png" alt="" width="512" height="512" decoding="async">
        <span class="nav__brand-text">Michael Motet Hansen</span>
      </a>
      <ul class="nav__links">
        <li><a href="/#projects">Projects</a></li>
        <li><a href="/#research">Research</a></li>
        <li><a href="/writing/">Writing</a></li>
        <li><a href="https://michael.motethansen.com" target="_blank" rel="noopener">Resume</a></li>
        <li><a href="/#contact">Contact</a></li>
      </ul>
    </nav>
  </header>`;

const FOOTER = `<footer class="site-footer">
    <div class="container site-footer__inner">
      <p class="site-footer__copy">
        <img class="site-footer__mark" src="/assets/img/logo-smartcity.png" alt="" width="512" height="512" loading="lazy" decoding="async">
        <span>&copy; ${new Date().getUTCFullYear()} Michael Motet Hansen</span>
      </p>
      <ul class="site-footer__links">
        <li><a href="https://github.com/motethansen" target="_blank" rel="noopener">GitHub</a></li>
        <li><a href="https://mastodon.sg/@motethansen" target="_blank" rel="noopener me">Mastodon</a></li>
        <li><a href="https://orcid.org/0000-0001-7645-5958" target="_blank" rel="noopener">ORCID</a></li>
      </ul>
    </div>
  </footer>`;

export function articlePage(site, a, bodyHtml) {
  const url = articleUrl(site, a);
  const cover = absolute(site, a.cover);
  const published = a.published_at || a.created_at;
  const ld = {
    "@context": "https://schema.org", "@type": "Article", headline: a.title, description: a.description || undefined,
    datePublished: iso(published), dateModified: iso(a.updated_at), image: cover || undefined,
    author: { "@type": "Person", name: SITES[site].name, url: SITES[site].origin }, mainEntityOfPage: url,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${esc(a.title)} — ${esc(SITES[site].name)}</title>
  <meta name="description" content="${esc(a.description)}">
  <meta name="author" content="${esc(SITES[site].name)}">
  <meta name="theme-color" content="#fbfaf7">
  <link rel="canonical" href="${esc(url)}">
  <link rel="alternate" type="application/rss+xml" title="Writing" href="/writing/rss.xml">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(a.title)}">
  <meta property="og:description" content="${esc(a.description)}">
  <meta property="og:url" content="${esc(url)}">
  ${cover ? `<meta property="og:image" content="${esc(cover)}">` : ""}
  <meta property="article:published_time" content="${iso(published)}">
  <meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">
  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
  <link rel="stylesheet" href="/style.css">
  <style>${ARTICLE_CSS}</style>
</head>
<body>
  ${HEADER}
  <main id="main">
    <section class="section">
      <div class="container">
        <article class="article">
          <a class="archive-back" href="/writing/"><span aria-hidden="true">←</span> All articles</a>
          <h1 class="section__title">${esc(a.title)}</h1>
          <p class="article__meta"><time datetime="${iso(published)}">${dateLong(published)}</time></p>
          ${a.cover ? `<img class="article__cover" src="${esc(a.cover)}" alt="" decoding="async">` : ""}
          <div class="article__body">${bodyHtml}</div>
          ${a.tags.length ? `<p class="article__tags">${a.tags.map(t => `#${esc(t)}`).join(" ")}</p>` : ""}
        </article>
      </div>
    </section>
  </main>
  ${FOOTER}
</body>
</html>`;
}

/** Entry shape shared with the Substack posts the /writing page already lists. */
export function feedEntry(site, a) {
  return {
    title: a.title, url: articleUrl(site, a), date: iso(a.published_at || a.created_at),
    image: absolute(site, a.cover) || null, description: a.description,
    source: SITES[site].name, platform: "motethansen.com", sourceLink: `${SITES[site].origin}/writing/`, sourceId: "native",
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
