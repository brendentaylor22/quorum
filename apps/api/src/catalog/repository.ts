import type { CatalogItem } from '@quorum/catalog';
import type { QuorumDatabase } from '@quorum/database';

export interface TaxonomyEntry {
  id: number;
  name: string;
}

/**
 * Everything a catalog row needs, whichever source produced it. `@quorum/tmdb`
 * `RatedCatalogItem` satisfies this structurally; the fixture path fills the
 * ranking fields with zeros, which leaves fixture slates in stable id order.
 */
export interface CatalogWriteItem extends CatalogItem {
  voteAverage: number;
  voteCount: number;
  popularity: number;
  weightedRating: number;
  genres: readonly TaxonomyEntry[];
  keywords: readonly TaxonomyEntry[];
}

/** Project a plain catalog item onto the write shape with no ranking signal. */
export function unrankedWriteItem(item: CatalogItem): CatalogWriteItem {
  return {
    ...item,
    voteAverage: 0,
    voteCount: 0,
    popularity: 0,
    weightedRating: 0,
    genres: [],
    keywords: [],
  };
}

export interface CatalogVersionRow {
  version: string;
  provider: string;
  itemCount: number;
  minVoteCount: number;
  poolMeanRating: number;
  startedAt: string;
  completedAt: string | null;
  /** Provider CDN base for posters, captured at import time. */
  imageBaseUrl: string | null;
  /** Poster size chosen from what the provider offered. */
  posterSize: string | null;
}

export interface CatalogStatus {
  current: CatalogVersionRow | null;
  activeItems: number;
  totalItems: number;
}

/**
 * Write a finished import and make it current, in one transaction.
 *
 * The network phase holds no lock at all: items are fetched, mapped, and
 * ranked in memory first, so the database is only touched once the whole
 * catalog is known good. A reader therefore sees the previous catalog right up
 * until it sees the new one, and never a half-written mixture.
 */
export function commitCatalogVersion(
  database: QuorumDatabase,
  input: {
    version: string;
    provider: string;
    minVoteCount: number;
    poolMeanRating: number;
    startedAt: string;
    completedAt: string;
    imageBaseUrl?: string | null;
    posterSize?: string | null;
    items: readonly CatalogWriteItem[];
  },
): number {
  const upsertItem = database.prepare(
    `INSERT INTO catalog_items (
       provider, provider_ref, media_type, title, release_year, synopsis,
       runtime_minutes, content_rating, language, image_ref, catalog_version,
       source_fetched_at, imported_at, vote_average, vote_count, popularity,
       weighted_rating, active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET
       title = excluded.title,
       release_year = excluded.release_year,
       synopsis = excluded.synopsis,
       runtime_minutes = excluded.runtime_minutes,
       content_rating = excluded.content_rating,
       language = excluded.language,
       image_ref = excluded.image_ref,
       catalog_version = excluded.catalog_version,
       source_fetched_at = excluded.source_fetched_at,
       imported_at = excluded.imported_at,
       vote_average = excluded.vote_average,
       vote_count = excluded.vote_count,
       popularity = excluded.popularity,
       weighted_rating = excluded.weighted_rating`,
  );
  const findItem = database.prepare(
    'SELECT id FROM catalog_items WHERE provider = ? AND provider_ref = ?',
  );

  return database.transaction(() => {
    database
      .prepare(
        `INSERT INTO catalog_versions (
           version, provider, min_vote_count, started_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT (version) DO UPDATE SET
           provider = excluded.provider,
           min_vote_count = excluded.min_vote_count,
           started_at = excluded.started_at`,
      )
      .run(input.version, input.provider, input.minVoteCount, input.startedAt);

    for (const item of input.items) {
      upsertItem.run(
        item.provider,
        item.providerRef,
        item.mediaType,
        item.title,
        item.releaseYear,
        item.synopsis,
        item.runtimeMinutes,
        item.contentRating,
        item.language,
        item.posterRef,
        input.version,
        item.sourceFetchedAt,
        input.completedAt,
        item.voteAverage,
        item.voteCount,
        item.popularity,
        item.weightedRating,
      );
      const row = findItem.get(item.provider, item.providerRef) as
        { id: number } | undefined;
      if (row === undefined) throw new Error('Catalog item did not persist');
      linkTaxonomy(database, row.id, item);
    }

    database
      .prepare(
        'UPDATE catalog_versions SET is_current = 0 WHERE is_current = 1',
      )
      .run();
    database
      .prepare(
        `UPDATE catalog_versions
            SET is_current = 1, item_count = ?, pool_mean_rating = ?,
                completed_at = ?, image_base_url = ?, poster_size = ?
          WHERE version = ?`,
      )
      .run(
        input.items.length,
        input.poolMeanRating,
        input.completedAt,
        input.imageBaseUrl ?? null,
        input.posterSize ?? null,
        input.version,
      );
    // Rows from any earlier version are retired, never deleted: room_items
    // still reference them and results must stay reproducible.
    database
      .prepare(
        'UPDATE catalog_items SET active = CASE WHEN catalog_version = ? THEN 1 ELSE 0 END',
      )
      .run(input.version);

    return input.items.length;
  })();
}

function linkTaxonomy(
  database: QuorumDatabase,
  catalogItemId: number,
  item: CatalogWriteItem,
): void {
  replaceLinks(
    database,
    'catalog_genres',
    'catalog_item_genres',
    'genre_id',
    catalogItemId,
    item.provider,
    item.genres,
  );
  replaceLinks(
    database,
    'catalog_keywords',
    'catalog_item_keywords',
    'keyword_id',
    catalogItemId,
    item.provider,
    item.keywords,
  );
}

/**
 * Table and column names are compile-time literals from `linkTaxonomy`, never
 * caller input; every value is still bound as a parameter.
 */
function replaceLinks(
  database: QuorumDatabase,
  taxonomyTable: 'catalog_genres' | 'catalog_keywords',
  linkTable: 'catalog_item_genres' | 'catalog_item_keywords',
  linkColumn: 'genre_id' | 'keyword_id',
  catalogItemId: number,
  provider: string,
  entries: readonly TaxonomyEntry[],
): void {
  database
    .prepare(`DELETE FROM ${linkTable} WHERE catalog_item_id = ?`)
    .run(catalogItemId);
  const upsert = database.prepare(
    `INSERT INTO ${taxonomyTable} (provider, provider_ref, name)
     VALUES (?, ?, ?)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET name = excluded.name
     RETURNING id`,
  );
  const link = database.prepare(
    `INSERT INTO ${linkTable} (catalog_item_id, ${linkColumn})
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
  );
  for (const entry of entries) {
    const row = upsert.get(provider, entry.id.toString(), entry.name) as {
      id: number;
    };
    link.run(catalogItemId, row.id);
  }
}

/**
 * TMDB's terms cap how long their content may be cached. Beyond this the
 * catalog must be refreshed or purged, so it is a retention deadline rather
 * than a tuning knob. See `docs/phase-0/tmdb-use-review.md`.
 */
export const TMDB_CACHE_MAX_DAYS = 180;

/**
 * Delete retired provider content that is past the cache limit and no longer
 * referenced by any room.
 *
 * Retiring alone is not enough: rows dropped by a later import would otherwise
 * hold provider metadata forever. Rows still referenced by `room_items` are
 * left alone — deleting them would break an in-flight room and rewrite history
 * — and are collected once those rooms expire and cascade away.
 */
export function purgeRetiredCatalogItems(
  database: QuorumDatabase,
  cutoff: string,
): number {
  const result = database
    .prepare(
      `DELETE FROM catalog_items
        WHERE active = 0
          AND imported_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM room_items WHERE room_items.catalog_item_id = catalog_items.id
          )`,
    )
    .run(cutoff);
  return result.changes;
}

/** Cutoff timestamp for the provider cache limit. */
export function cacheCutoff(now: Date, maxDays = TMDB_CACHE_MAX_DAYS): string {
  return new Date(now.getTime() - maxDays * 86_400_000).toISOString();
}

export function catalogStatus(database: QuorumDatabase): CatalogStatus {
  const current = database
    .prepare(
      `SELECT version, provider, item_count AS itemCount,
              min_vote_count AS minVoteCount, pool_mean_rating AS poolMeanRating,
              started_at AS startedAt, completed_at AS completedAt,
              image_base_url AS imageBaseUrl, poster_size AS posterSize
         FROM catalog_versions WHERE is_current = 1`,
    )
    .get() as CatalogVersionRow | undefined;
  const counts = database
    .prepare(
      `SELECT count(*) AS total,
              coalesce(sum(active), 0) AS active
         FROM catalog_items`,
    )
    .get() as { total: number; active: number };
  return {
    current: current ?? null,
    activeItems: counts.active,
    totalItems: counts.total,
  };
}

/**
 * Age of the current catalog in whole days, or null when nothing is imported.
 * Used to warn an operator rather than to block anything.
 */
export function catalogAgeDays(
  database: QuorumDatabase,
  now: Date,
): number | null {
  const status = catalogStatus(database);
  const completedAt = status.current?.completedAt;
  if (completedAt === undefined || completedAt === null) return null;
  const elapsed = now.getTime() - Date.parse(completedAt);
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}
