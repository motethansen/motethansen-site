-- Articles that live elsewhere (Substack posts, old LinkedIn articles): a row with no body that links out.
-- Pulled hourly by the mac-mini (scripts/substack_sync.py) and upserted by POST /api/ingest/external.
ALTER TABLE articles ADD COLUMN external_url TEXT;
ALTER TABLE articles ADD COLUMN source TEXT;      -- e.g. "Vizneo Academy"
ALTER TABLE articles ADD COLUMN platform TEXT;    -- e.g. "Substack"
CREATE UNIQUE INDEX IF NOT EXISTS articles_external_url ON articles (external_url) WHERE external_url IS NOT NULL;
