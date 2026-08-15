import type { QuorumDatabase } from '@quorum/database';
import type { TaggedItem } from '@quorum/recommend';

/**
 * Turn catalog rows into the tag vectors the recommender scores.
 *
 * This is the only place the recommender's view of a movie is decided, and the
 * only place it depends on provider-derived metadata. Swapping or narrowing
 * the feature set — if the provider's terms require it — is a change to this
 * file alone; nothing in `@quorum/recommend` knows what a genre is.
 */
export function catalogFeatures(
  database: QuorumDatabase,
  catalogItemIds: readonly number[],
): TaggedItem[] {
  if (catalogItemIds.length === 0) return [];
  const placeholders = catalogItemIds.map(() => '?').join(',');
  const rows = database
    .prepare(
      `SELECT c.id AS id, c.release_year AS releaseYear,
              c.runtime_minutes AS runtimeMinutes, c.language AS language,
              (SELECT group_concat(genre_id) FROM catalog_item_genres
                WHERE catalog_item_id = c.id) AS genreIds,
              (SELECT group_concat(keyword_id) FROM catalog_item_keywords
                WHERE catalog_item_id = c.id) AS keywordIds
         FROM catalog_items c
        WHERE c.id IN (${placeholders})`,
    )
    .all(...catalogItemIds) as {
    id: number;
    releaseYear: number | null;
    runtimeMinutes: number | null;
    language: string | null;
    genreIds: string | null;
    keywordIds: string | null;
  }[];

  return rows.map((row) => ({
    item: row.id.toString(),
    tags: [
      ...splitIds(row.genreIds).map((id) => `genre:${id}`),
      ...splitIds(row.keywordIds).map((id) => `keyword:${id}`),
      ...decadeTag(row.releaseYear),
      ...runtimeTag(row.runtimeMinutes),
      ...(row.language === null ? [] : [`language:${row.language}`]),
    ],
  }));
}

function splitIds(value: string | null): string[] {
  if (value === null || value === '') return [];
  return value.split(',').filter((entry) => entry !== '');
}

function decadeTag(releaseYear: number | null): string[] {
  if (releaseYear === null) return [];
  return [`decade:${(Math.floor(releaseYear / 10) * 10).toString()}`];
}

/**
 * Runtime as a coarse band. "Do we want a long film tonight" is a real
 * preference, and an exact minute count is not a feature anything can learn
 * from twenty swipes.
 */
function runtimeTag(runtimeMinutes: number | null): string[] {
  if (runtimeMinutes === null || runtimeMinutes <= 0) return [];
  if (runtimeMinutes < 95) return ['runtime:short'];
  if (runtimeMinutes <= 130) return ['runtime:medium'];
  return ['runtime:long'];
}
