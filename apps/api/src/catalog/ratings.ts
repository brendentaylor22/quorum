import type { QuorumDatabase } from '@quorum/database';
import { OmdbStopError, type ExternalRatings } from './omdb.js';

/** Ratings columns as stored on, and carried between, catalog versions. */
export interface RatingFields extends ExternalRatings {
  /** Null means never looked up; set even when OMDb had nothing. */
  ratingsFetchedAt: string | null;
}

const NONE: RatingFields = {
  imdbRating: null,
  imdbVotes: null,
  rtScore: null,
  ratingsFetchedAt: null,
};

export interface RatingsOptions {
  /** Omit to only carry stored ratings forward, as when no key is configured. */
  lookup?:
    | ((imdbId: string, signal?: AbortSignal) => Promise<ExternalRatings>)
    | undefined;
  /** Most lookups this run may spend. */
  budget: number;
  /** Re-look-up a film once its ratings are this old. */
  staleAfterDays: number;
  now: Date;
  signal?: AbortSignal | undefined;
}

export interface RatingsReport {
  fetched: number;
  failed: number;
  /** Films with an IMDb id still lacking fresh ratings after this run. */
  pending: number;
  /** OMDb refused further requests (quota or key) before the budget ran out. */
  stoppedEarly: boolean;
}

interface StoredRow extends RatingFields {
  providerRef: string;
  imdbId: string | null;
}

/**
 * Carry ratings forward from the stored catalog, then spend the lookup budget
 * on what is missing or stale: never-looked-up films first, best-ranked first,
 * since the first slate is drawn from the top of the ranking.
 *
 * The free OMDb quota is smaller than a catalog, so a first import is filled
 * in over several runs. Carrying forward is also what stops a run without a
 * key from wiping ratings an earlier run paid for.
 */
export async function attachRatings<
  T extends {
    providerRef: string;
    imdbId: string | null;
    weightedRating: number;
  },
>(
  database: QuorumDatabase,
  items: readonly T[],
  options: RatingsOptions,
): Promise<{ items: (T & RatingFields)[]; report: RatingsReport }> {
  const stored = new Map(
    (
      database
        .prepare(
          `SELECT provider_ref AS providerRef, imdb_id AS imdbId,
                  imdb_rating AS imdbRating, imdb_votes AS imdbVotes,
                  rt_score AS rtScore, ratings_fetched_at AS ratingsFetchedAt
             FROM catalog_items WHERE provider = 'tmdb'`,
        )
        .all() as StoredRow[]
    ).map((row) => [row.providerRef, row]),
  );

  const merged = items.map((item): T & RatingFields => {
    const prior = stored.get(item.providerRef);
    // A changed IMDb id means TMDB re-pointed the film; old scores are stale.
    return { ...item, ...(prior?.imdbId === item.imdbId ? prior : NONE) };
  });

  const staleBefore =
    options.now.getTime() - options.staleAfterDays * 86_400_000;
  const due = merged
    .filter(
      (item) =>
        item.imdbId !== null &&
        (item.ratingsFetchedAt === null ||
          Date.parse(item.ratingsFetchedAt) < staleBefore),
    )
    .sort(
      (left, right) =>
        Number(left.ratingsFetchedAt !== null) -
          Number(right.ratingsFetchedAt !== null) ||
        right.weightedRating - left.weightedRating,
    );

  const report: RatingsReport = {
    fetched: 0,
    failed: 0,
    pending: due.length,
    stoppedEarly: false,
  };
  const { lookup } = options;
  if (lookup === undefined) return { items: merged, report };

  for (const item of due.slice(0, options.budget)) {
    if (options.signal?.aborted === true) break;
    const imdbId = item.imdbId;
    if (imdbId === null) continue;
    try {
      Object.assign(item, await lookup(imdbId, options.signal), {
        ratingsFetchedAt: options.now.toISOString(),
      });
      report.fetched += 1;
      report.pending -= 1;
    } catch (error) {
      if (error instanceof OmdbStopError) {
        report.stoppedEarly = true;
        break;
      }
      // One bad film must not cost the rest of the run; it stays due.
      report.failed += 1;
    }
  }
  return { items: merged, report };
}
