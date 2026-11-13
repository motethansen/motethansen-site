/**
 * Markdown -> HTML for article bodies, safe by construction:
 *   - raw HTML in the source is escaped (html: false), so no <script>, <iframe>, onerror=...
 *   - markdown-it already refuses javascript:, vbscript:, file: and data: (non-image) links
 *   - images may only come from our own /media/ or https://
 *   - external links get rel="noopener noreferrer"
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

const linkOpen = md.renderer.rules.link_open || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const href = t.attrGet("href") || "";
  if (/^https?:\/\//i.test(href)) {
    t.attrSet("rel", "noopener noreferrer");
    t.attrSet("target", "_blank");
  }
  return linkOpen(tokens, idx, opts, env, self);
};

const imageRule = md.renderer.rules.image || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const src = t.attrGet("src") || "";
  if (!(src.startsWith("/media/") || src.startsWith("https://"))) {
    return md.utils.escapeHtml(t.content || "");             // refuse the image, keep the alt text
  }
  t.attrSet("loading", "lazy");
  t.attrSet("decoding", "async");
  return imageRule(tokens, idx, opts, env, self);
};

// ---- YouTube: a line that is nothing but a YouTube address becomes a player (privacy-enhanced domain, lazy-loaded).
// A link with its own text ([Watch](https://youtu.be/...)) stays a plain link. Only an 11-character video id is ever
// placed in the iframe address, so nothing from the pasted text can change where the frame points.
const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])(?:[?&#/].*)?$/;
export const youtubeId = url => (String(url).match(YOUTUBE) || [])[1] || null;

md.core.ruler.push("youtube_embed", state => {
  const t = state.tokens;
  for (let i = 0; i + 2 < t.length; i++) {
    if (t[i].type !== "paragraph_open" || t[i + 1].type !== "inline" || t[i + 2].type !== "paragraph_close") continue;
    const kids = t[i + 1].children || [];
    if (kids.length !== 3 || kids[0].type !== "link_open" || kids[1].type !== "text" || kids[2].type !== "link_close") continue;
    const href = kids[0].attrGet("href") || "";
    const id = kids[1].content === href ? youtubeId(href) : null;           // bare address only
    if (!id) continue;
    const tok = new state.Token("youtube_embed", "", 0);
    tok.meta = { id, href };
    t.splice(i, 3, tok);
  }
});

md.renderer.rules.youtube_embed = (tokens, idx, opts, env) => {
  const { id, href } = tokens[idx].meta;
  if (env && env.embeds === false) {                                        // RSS and other places where frames are stripped
    return `<p><a href="https://www.youtube.com/watch?v=${id}" rel="noopener noreferrer">Watch the video on YouTube</a></p>\n`;
  }
  return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube video" loading="lazy" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>\n`;
};

export const renderMarkdown = (src, { embeds = true } = {}) => md.render(String(src || ""), { embeds });

/** Plain-text excerpt for descriptions when none was written. */
export function excerpt(src, n = 180) {
  const text = String(src || "")
    .replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= n ? text : text.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

/** The first image in a Markdown body that the site may show (our own storage or https), or null. */
export function firstImage(src) {
  for (const m of String(src || "").matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    if (m[1].startsWith("/media/") || m[1].startsWith("https://")) return m[1];
  }
  return null;
}

/** Clip to about n characters at a word boundary, with an ellipsis. */
export function clip(text, n = 220) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}
