import { ENABLED_SITES } from "./sites.js";

export const RESERVED_SLUGS = new Set(["rss-xml", "index-json", "new", "admin", "media", "api"]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(title) {
  return String(title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/, "");
}

const isHttps = v => { try { return new URL(v).protocol === "https:"; } catch { return false; } };

/**
 * Validate a full article record. Returns { value, errors }.
 * `now` is injected so published_at limits are testable.
 */
export function validateArticle(input, now = Math.floor(Date.now() / 1000)) {
  const errors = [];
  const v = {};

  v.title = String(input.title ?? "").trim();
  if (!v.title) errors.push("A title is required.");
  else if (v.title.length > 200) errors.push("The title is limited to 200 characters.");

  v.slug = String(input.slug ?? "").trim() || slugify(v.title);
  if (!SLUG_RE.test(v.slug) || v.slug.length < 3 || v.slug.length > 100) {
    errors.push("The address (slug) must be 3-100 characters: lowercase letters, numbers and single dashes.");
  } else if (RESERVED_SLUGS.has(v.slug)) {
    errors.push(`"${v.slug}" is reserved; choose another address.`);
  }

  v.description = String(input.description ?? "").trim();
  if (v.description.length > 400) errors.push("The description is limited to 400 characters.");

  v.body_md = String(input.body_md ?? "");
  if (v.body_md.length > 200_000) errors.push("The article is limited to 200,000 characters.");

  const cover = input.cover == null ? "" : String(input.cover).trim();
  if (cover && !(/^\/media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(cover) || isHttps(cover))) {
    errors.push("The cover image must be an uploaded image or an https:// address.");
  }
  v.cover = cover || null;

  const tags = Array.isArray(input.tags) ? input.tags : [];
  v.tags = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
  if (v.tags.length > 10 || v.tags.some(t => t.length > 40)) errors.push("Use at most 10 tags of 40 characters each.");

  const sites = Array.isArray(input.sites) ? input.sites : [];
  v.sites = [...new Set(sites.map(String))];
  if (!v.sites.length) errors.push("Choose at least one site to publish on.");
  else if (v.sites.some(s => !ENABLED_SITES.includes(s))) errors.push("Unknown site.");

  const pa = input.published_at;
  if (pa == null || pa === "") v.published_at = null;
  else if (!Number.isInteger(pa) || pa < 0 || pa > now + 366 * 86400) errors.push("The publish date is not valid.");
  else v.published_at = pa;

  const origin = input.origin_url == null ? "" : String(input.origin_url).trim();
  if (origin && !isHttps(origin)) errors.push("The original address must start with https://");
  v.origin_url = origin || null;

  return { value: v, errors };
}
