-- Articles written in the /admin editor. `sites` is a JSON array of the sites that publish the article.
CREATE TABLE IF NOT EXISTS articles (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  body_md      TEXT NOT NULL DEFAULT '',
  cover        TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  sites        TEXT NOT NULL DEFAULT '["motethansen"]',
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  origin_url   TEXT
);
CREATE INDEX IF NOT EXISTS articles_status_pub ON articles (status, published_at DESC);
