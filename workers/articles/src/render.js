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

export const renderMarkdown = src => md.render(String(src || ""));

/** Plain-text excerpt for descriptions when none was written. */
export function excerpt(src, n = 180) {
  const text = String(src || "")
    .replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= n ? text : text.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}
