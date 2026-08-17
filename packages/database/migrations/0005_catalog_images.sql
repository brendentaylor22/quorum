-- Image delivery details captured at import time.
--
-- TMDB requires posters be served from their CDN, and publishes the base URL
-- and the available sizes through `/configuration` rather than guaranteeing a
-- fixed host. Only the importer can reach TMDB, so it records what the client
-- needs and the serving application never has to ask.

ALTER TABLE catalog_versions ADD COLUMN image_base_url TEXT;
ALTER TABLE catalog_versions ADD COLUMN poster_size TEXT;
