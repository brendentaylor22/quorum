-- Real catalog ingestion. Adds the ranking signal needed to pick "top movies
-- of all time", the feature tables the recommender will need later, and the
-- version bookkeeping that makes an import atomic from a reader's point of
-- view.
--
-- Catalog rows are never deleted: `room_items.catalog_item_id` references them,
-- so a movie that drops out of a later import must survive as `active = 0` or
-- in-flight rooms and historical results break.

ALTER TABLE catalog_items ADD COLUMN vote_average REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_items ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_items ADD COLUMN popularity REAL NOT NULL DEFAULT 0;

-- Bayesian weighted rating, computed at import against the whole pool. Stored
-- rather than derived so slate selection is a single indexed scan.
ALTER TABLE catalog_items ADD COLUMN weighted_rating REAL NOT NULL DEFAULT 0;

-- Only rows belonging to the current catalog version are selectable.
ALTER TABLE catalog_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1
  CHECK (active IN (0, 1));

CREATE INDEX catalog_items_ranked
  ON catalog_items (active, weighted_rating DESC, id);

CREATE TABLE catalog_genres (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
) STRICT;

CREATE TABLE catalog_item_genres (
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items (id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES catalog_genres (id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_item_id, genre_id)
) STRICT;

CREATE INDEX catalog_item_genres_genre ON catalog_item_genres (genre_id);

CREATE TABLE catalog_keywords (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
) STRICT;

CREATE TABLE catalog_item_keywords (
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items (id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES catalog_keywords (id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_item_id, keyword_id)
) STRICT;

CREATE INDEX catalog_item_keywords_keyword ON catalog_item_keywords (keyword_id);

-- One row per import attempt. `is_current` is flipped in the same transaction
-- that activates the rows, so a failed or partial import leaves the previous
-- catalog serving untouched.
CREATE TABLE catalog_versions (
  version TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  min_vote_count INTEGER NOT NULL DEFAULT 0,
  pool_mean_rating REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1))
) STRICT;

-- At most one current catalog version at any time.
CREATE UNIQUE INDEX catalog_versions_current
  ON catalog_versions (is_current) WHERE is_current = 1;

-- Adopt whatever the Phase 2 fixture import already wrote so an existing
-- database keeps serving without a re-import.
INSERT INTO catalog_versions (
  version, provider, item_count, started_at, completed_at, is_current
)
SELECT catalog_version, provider, count(*), min(imported_at), max(imported_at), 1
  FROM catalog_items
 GROUP BY catalog_version, provider
 ORDER BY max(imported_at) DESC
 LIMIT 1;

-- Anything outside the adopted version is retired rather than removed.
UPDATE catalog_items
   SET active = CASE
     WHEN catalog_version = (
       SELECT version FROM catalog_versions WHERE is_current = 1
     ) THEN 1 ELSE 0 END
 WHERE EXISTS (SELECT 1 FROM catalog_versions WHERE is_current = 1);
