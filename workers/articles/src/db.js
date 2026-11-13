/** D1 queries for articles. `db` is a D1 database (or the node:sqlite adapter used in tests). */

const COLS_LIST = "id, slug, title, description, cover, tags, sites, status, published_at, created_at, updated_at, origin_url, external_url, source, platform, provisional";
const COLS_FULL = COLS_LIST + ", body_md";

const parse = r => r && { ...r, tags: JSON.parse(r.tags || "[]"), sites: JSON.parse(r.sites || "[]") };

// external: false = only articles written here, true = only linked-out ones (Substack, LinkedIn), null = both
export async function listArticles(db, { status = null, site = null, q = null, limit = 100, external = null } = {}) {
  const like = q ? `%${String(q).replace(/[%_]/g, m => "\\" + m)}%` : null;
  const { results } = await db.prepare(
    `SELECT ${COLS_LIST} FROM articles
      WHERE (? IS NULL OR status = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(articles.sites) WHERE value = ?))
        AND (? IS NULL OR title LIKE ? ESCAPE '\\')
        AND (? IS NULL OR (? = 1) = (external_url IS NOT NULL))
        AND NOT (external_url IS NOT NULL AND EXISTS (          -- a linked-out entry steps aside once its own copy is published here
              SELECT 1 FROM articles n WHERE n.external_url IS NULL AND n.status = 'published' AND n.origin_url IS NOT NULL
                 AND rtrim(n.origin_url, '/') = rtrim(articles.external_url, '/')))
      ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
      LIMIT ?`,
  ).bind(status, status, site, site, like, like, external === null ? null : +external, external === null ? null : +external, Math.min(limit, 500)).all();
  return results.map(parse);
}

export async function getById(db, id) {
  return parse(await db.prepare(`SELECT ${COLS_FULL} FROM articles WHERE id = ?`).bind(id).first());
}

export async function getPublishedBySlug(db, slug, site) {
  return parse(await db.prepare(
    `SELECT ${COLS_FULL} FROM articles
      WHERE slug = ? AND status = 'published' AND external_url IS NULL
        AND EXISTS (SELECT 1 FROM json_each(articles.sites) WHERE value = ?)`,
  ).bind(slug, site).first());
}

export async function createArticle(db, a, now = Math.floor(Date.now() / 1000)) {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO articles (id, slug, title, description, body_md, cover, tags, sites, status, published_at, created_at, updated_at, origin_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).bind(id, a.slug, a.title, a.description, a.body_md, a.cover, JSON.stringify(a.tags), JSON.stringify(a.sites),
    a.published_at, now, now, a.origin_url).run();
  return getById(db, id);
}

export async function updateArticle(db, id, a, now = Math.floor(Date.now() / 1000)) {
  const r = await db.prepare(
    `UPDATE articles SET slug = ?, title = ?, description = ?, body_md = ?, cover = ?, tags = ?, sites = ?,
            published_at = ?, origin_url = ?, updated_at = ? WHERE id = ?`,
  ).bind(a.slug, a.title, a.description, a.body_md, a.cover, JSON.stringify(a.tags), JSON.stringify(a.sites),
    a.published_at, a.origin_url, now, id).run();
  return r.meta.changes ? getById(db, id) : null;
}

export async function setStatus(db, id, status, now = Math.floor(Date.now() / 1000)) {
  // publishing stamps the date once; unpublishing keeps it so re-publishing does not reorder history
  const r = await db.prepare(
    `UPDATE articles SET status = ?,
            published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at,
                 (SELECT e.published_at FROM articles e WHERE e.external_url IS NOT NULL AND e.published_at IS NOT NULL    -- the original's date, when migrating
                    AND articles.origin_url IS NOT NULL AND rtrim(e.external_url, '/') = rtrim(articles.origin_url, '/') LIMIT 1), ?)
               ELSE published_at END,
            updated_at = ? WHERE id = ?`,
  ).bind(status, status, now, now, id).run();
  return r.meta.changes ? getById(db, id) : null;
}

export async function deleteArticle(db, id) {
  const r = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}

export const isUniqueViolation = e => /UNIQUE constraint failed/i.test(String(e?.message || e));


/** A stable, valid slug for a linked-out entry: derived from its address, so re-importing never creates a second row. */
export async function externalSlug(url) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return "ext-" + [...h.slice(0, 6)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Insert or refresh one linked-out entry (matched by its address). Refreshes only the facts about the post;
 * `status` is never touched, so hiding an entry in the editor survives the next sync.
 * @returns {"inserted"|"updated"}
 */
export async function upsertExternal(db, src, e, now = Math.floor(Date.now() / 1000), provisional = 0) {
  const existing = await db.prepare("SELECT id FROM articles WHERE external_url = ?").bind(e.url).first();
  await db.prepare(
    `INSERT INTO articles (id, slug, title, description, body_md, cover, tags, sites, status, published_at, created_at, updated_at,
                           origin_url, external_url, source, platform, provisional)
     VALUES (?, ?, ?, ?, '', ?, '[]', ?, 'published', ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (external_url) WHERE external_url IS NOT NULL DO UPDATE SET
       title = excluded.title, description = excluded.description, cover = excluded.cover,
       published_at = COALESCE(excluded.published_at, articles.published_at), updated_at = excluded.updated_at,
       provisional = excluded.provisional`,
  ).bind(crypto.randomUUID(), await externalSlug(e.url), e.title, e.description, e.image, JSON.stringify(src.sites),
    e.published_at, now, now, e.url, src.source, src.platform, provisional).run();
  return existing ? "updated" : "inserted";
}

/**
 * After a full pull of a source: remove provisional entries that the pull did not see and that are old enough that it
 * should have (the pull lists every post, newest first). Never touches confirmed entries.
 * @returns {Promise<number>} how many were removed
 */
export async function removeUnconfirmed(db, source, seenUrls, now = Math.floor(Date.now() / 1000), graceS = 1800) {
  const { results } = await db.prepare("SELECT id, external_url FROM articles WHERE provisional = 1 AND source = ? AND created_at < ?").bind(source, now - graceS).all();
  const gone = results.filter(r => !seenUrls.includes(r.external_url));
  for (const r of gone) await db.prepare("DELETE FROM articles WHERE id = ? AND provisional = 1").bind(r.id).run();
  return gone.length;
}
