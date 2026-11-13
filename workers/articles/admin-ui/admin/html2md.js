// Pasted web page (clipboard text/html) -> Markdown. Dependency-free; uses the browser's DOMParser.
// Built for copying an article off LinkedIn/Substack: headings, bold/italic, links, lists, quotes, code, images.

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "IFRAME", "FORM", "INPUT", "NAV", "ASIDE"]);
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "TABLE", "TR", "DL", "DT", "DD"]);

const esc = t => t.replace(/([\\`*\[\]])/g, "\\$1");

function wrapInline(mark, inner) {
  const core = inner.trim();
  if (!core) return inner.length ? " " : "";
  const lead = inner.match(/^\s*/)[0] ? " " : "";
  const tail = inner.match(/\s*$/)[0] ? " " : "";
  return `${lead}${mark}${core}${mark}${tail}`;
}

function imageSrc(el) {
  const src = el.getAttribute("src") || el.getAttribute("data-delayed-url") || el.getAttribute("data-src") || "";
  if (!/^(https?:\/\/|\/media\/)/.test(src)) return "";                       // drops data: URIs and relative junk
  const w = Number(el.getAttribute("width")), h = Number(el.getAttribute("height"));
  return (w && w <= 2) || (h && h <= 2) ? "" : src;                           // tracking pixels
}

function list(el, depth) {
  const ordered = el.tagName === "OL";
  let n = Number(el.getAttribute("start")) || 1;
  const pad = "  ".repeat(depth);
  let out = "";                                   // one line per item, each ending in "\n"; nested lists follow their item
  for (const li of el.children) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const nested = [];
    let text = "";
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) nested.push(list(c, depth + 1));
      else text += render(c, depth + 1);
    }
    out += `${pad}${marker}${text.replace(/\n{2,}/g, " ").replace(/\s*\n\s*/g, " ").trim()}\n${nested.join("")}`;
  }
  return out;
}

function render(node, depth = 0, inPre = false) {
  if (node.nodeType === 3) return inPre ? node.nodeValue : esc(node.nodeValue.replace(/\s+/g, " "));
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  if (tag === "IFRAME") {                                                    // a pasted YouTube player becomes its address on its own line
    const m = (node.getAttribute("src") || "").match(/^(?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
    return m ? `\n\nhttps://www.youtube.com/watch?v=${m[1]}\n\n` : "";
  }
  if (SKIP.has(tag)) return "";
  const kids = () => [...node.childNodes].map(c => render(c, depth, inPre)).join("");

  if (/^H[1-6]$/.test(tag)) {
    const level = Math.max(2, Number(tag[1]));                                // the article page supplies the h1
    const text = kids().replace(/\s+/g, " ").trim();
    return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
  }
  switch (tag) {
    case "STRONG": case "B": return wrapInline("**", kids());
    case "EM": case "I": return wrapInline("_", kids());
    case "CODE": return inPre ? kids() : (kids().trim() ? `\`${node.textContent.trim()}\`` : "");
    case "PRE": return `\n\n\`\`\`\n${node.textContent.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    case "BR": return "\\\n";              // CommonMark hard break
    case "HR": return "\n\n---\n\n";
    case "A": {
      const href = node.getAttribute("href") || "";
      const inner = kids();
      if (!/^(https?:\/\/|mailto:)/i.test(href) || !inner.trim()) return inner;
      return `${inner.match(/^\s*/)[0] ? " " : ""}[${inner.trim()}](${href.replace(/\)/g, "%29")})${inner.match(/\s*$/)[0] ? " " : ""}`;
    }
    case "IMG": {
      const src = imageSrc(node);
      return src ? `\n\n![${esc((node.getAttribute("alt") || "").replace(/\s+/g, " ").trim())}](${src})\n\n` : "";
    }
    case "UL": case "OL": return `\n\n${list(node, depth).trimEnd()}\n\n`;
    case "BLOCKQUOTE": {
      const inner = kids().replace(/\n{3,}/g, "\n\n").trim();
      return inner ? `\n\n${inner.split("\n").map(l => (l ? `> ${l}` : ">")).join("\n")}\n\n` : "";
    }
    case "FIGCAPTION": { const t = kids().replace(/\s+/g, " ").trim(); return t ? `\n\n_${t}_\n\n` : ""; }
    case "TD": case "TH": return kids().replace(/\s+/g, " ").trim() + " | ";
    case "TR": return `\n\n${kids().replace(/ \| $/, "")}\n\n`;
    default: return BLOCK_TAGS.has(tag) ? `\n\n${kids()}\n\n` : kids();
  }
}

export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const md = [...doc.body.childNodes].map(n => render(n)).join("");
  return md.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n").replace(/(?<=\S) {2,}(?=\S)/g, " ").trim() + "\n";
}

/** Image addresses in pasted Markdown that live on a source we can import from (kept in step with the server allowlist). */
export const IMPORTABLE = /^https:\/\/(media(-exp\d+)?\.licdn\.com|substackcdn\.com|substack-post-media\.s3\.amazonaws\.com|bucketeer-[a-z0-9-]+\.s3\.amazonaws\.com)\//;
export function importableImages(md) {
  const urls = new Set();
  for (const m of md.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)) if (IMPORTABLE.test(m[1])) urls.add(m[1]);
  return [...urls];
}
