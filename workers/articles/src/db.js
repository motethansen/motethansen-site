/** D1 queries for articles. `db` is a D1 database (or the node:sqlite adapter used in tests). */

const COLS_LIST = "id, slug, title, description, cover, tags, sites, status, published_at, created_at, updated_at, origin_url";
const COLS_FULL = COLS_LIST + ", body_md";

const parse = r => r && { ...r, tags: JSON.parse(r.tags || "[]"), sites: JSON.parse(r.sites || "[]") };

export async function listArticles(db, { status = null, site = null, q = null, limit = 100 } = {}) {
  const like = q ? `%${String(q).replace(/[%_]/g, m => "\\" + m)}%` : null;
  const { results } = await db.prepare(
    `SELECT ${COLS_LIST} FROM articles
      WHERE (? IS NULL OR status = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(articles.sites) WHERE value = ?))
        AND (? IS NULL OR title LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
      LIMIT ?`,
  ).bind(status, status, site, site, like, like, Math.min(limit, 500)).all();
  return results.map(parse);
}

export async function getById(db, id) {
  return parse(await db.prepare(`SELECT ${COLS_FULL} FROM articles WHERE id = ?`).bind(id).first());
}

export async function getPublishedBySlug(db, slug, site) {
  return parse(await db.prepare(
    `SELECT ${COLS_FULL} FROM articles
      WHERE slug = ? AND status = 'published'
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
    `UPDATE articles SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
            updated_at = ? WHERE id = ?`,
  ).bind(status, status, now, now, id).run();
  return r.meta.changes ? getById(db, id) : null;
}

export async function deleteArticle(db, id) {
  const r = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}

export const isUniqueViolation = e => /UNIQUE constraint failed/i.test(String(e?.message || e));
