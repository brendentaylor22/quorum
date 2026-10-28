-- Third-party audience ratings, fetched at import time.
--
-- IMDb and Rotten Tomatoes scores come from OMDb, which the serving
-- application can never reach, so the importer records them here and carries
-- them across catalog versions. The free OMDb quota is far smaller than a full
-- catalog, so a run fills in what it can afford and the next run continues:
-- `ratings_fetched_at` is how it tells "looked up, nothing found" from "not
-- looked up yet". All columns are null until a lookup succeeds.

ALTER TABLE catalog_items ADD COLUMN imdb_id TEXT;
ALTER TABLE catalog_items ADD COLUMN imdb_rating REAL;
ALTER TABLE catalog_items ADD COLUMN imdb_votes INTEGER;
ALTER TABLE catalog_items ADD COLUMN rt_score INTEGER;
ALTER TABLE catalog_items ADD COLUMN ratings_fetched_at TEXT;
