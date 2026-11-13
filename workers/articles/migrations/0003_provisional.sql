-- A post added by address while Substack could not be read: listed with a title taken from the address until the
-- next pull confirms it (then 0) or, if the pull never sees it for 30 minutes, removes it (a mistyped address).
ALTER TABLE articles ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0;
