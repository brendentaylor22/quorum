import type { QuorumDatabase } from '@quorum/database';
import {
  TMDB_PROVIDER,
  applyWeightedRatings,
  discoverMovies,
  poolMeanRating,
  preferredPosterSize,
  toCatalogItem,
  type RejectionReason,
  type SliceReport,
  type TmdbCatalogItem,
  type TmdbClient,
} from '@quorum/tmdb';
import {
  cacheCutoff,
  commitCatalogVersion,
  purgeRetiredCatalogItems,
} from './repository.js';

export interface ImportOptions {
  minVoteCount: number;
  firstYear: number;
  lastYear: number;
  originalLanguage?: string | undefined;
  allowedLanguages?: readonly string[] | undefined;
  certificationRegions?: readonly string[] | undefined;
  /**
   * Confidence threshold for the weighted rating. Separate from
   * `minVoteCount`: inclusion and ranking are different questions, and a low
   * value here lets a hyped new release outrank an all-time classic.
   */
  ratingPriorVotes?: number | undefined;
  /** Parallel detail fetches. The client's rate limiter is the real throttle. */
  concurrency: number;
  /**
   * Stop after this many usable items. Guards an unbounded first import.
   *
   * Discovery runs newest year first, so hitting this cap drops the *oldest*
   * films rather than the least popular ones. `cappedAtMaxItems` in the report
   * says when that happened, so a truncated catalog is never silent.
   */
  maxItems: number;
  signal?: AbortSignal | undefined;
  now?: () => Date;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  phase: 'discover' | 'detail' | 'commit';
  discovered: number;
  fetched: number;
  accepted: number;
  rejected: number;
  failed: number;
}

export interface ImportReport {
  version: string;
  provider: string;
  discovered: number;
  accepted: number;
  rejected: number;
  failed: number;
  poolMeanRating: number;
  /** Poster CDN base and size recorded for the client. */
  imageBaseUrl: string | null;
  posterSize: string | null;
  rejections: Record<string, number>;
  truncatedYears: number[];
  /** Retired provider rows deleted under the cache limit. */
  purged: number;
  /**
   * True when the import stopped on `maxItems` rather than exhausting the
   * year range, meaning the oldest part of the catalog was never reached.
   */
  cappedAtMaxItems: boolean;
  startedAt: string;
  completedAt: string;
}

/** One version per import run, sortable and readable in an audit log. */
export function catalogVersionFor(now: Date): string {
  return `tmdb-${now.toISOString().replace(/[:.]/gu, '-')}`;
}

/**
 * Fetch, validate, rank, and install a TMDB catalog.
 *
 * The whole network phase runs before any write, so a failure at any point
 * leaves the previous catalog serving untouched. That is what lets the
 * application keep working during a TMDB outage.
 */
export async function importTmdbCatalog(
  database: QuorumDatabase,
  client: TmdbClient,
  options: ImportOptions,
): Promise<ImportReport> {
  const clock = options.now ?? (() => new Date());
  const startedAtDate = clock();
  const startedAt = startedAtDate.toISOString();
  const version = catalogVersionFor(startedAtDate);

  const rejections = new Map<RejectionReason, number>();
  const truncatedYears: number[] = [];
  const accepted: TmdbCatalogItem[] = [];
  let discovered = 0;
  let fetched = 0;
  let failed = 0;

  const report = (phase: ImportProgress['phase']): void => {
    options.onProgress?.({
      phase,
      discovered,
      fetched,
      accepted: accepted.length,
      rejected: countRejections(rejections),
      failed,
    });
  };

  const mapOptions = {
    catalogVersion: version,
    sourceFetchedAt: startedAt,
    minVoteCount: options.minVoteCount,
    ...(options.allowedLanguages === undefined
      ? {}
      : { allowedLanguages: options.allowedLanguages }),
    ...(options.certificationRegions === undefined
      ? {}
      : { certificationRegions: options.certificationRegions }),
  };

  // Poster delivery details, captured while egress is available. A failure
  // here must not lose an import: posters fall back to a placeholder tile.
  let imageBaseUrl: string | null = null;
  let posterSize: string | null = null;
  try {
    const configuration = await client.configuration(options.signal);
    imageBaseUrl = configuration.images.secure_base_url;
    posterSize = preferredPosterSize(configuration);
  } catch {
    // Leave both null; the client falls back to a placeholder tile.
  }

  const ids = discoverMovies(client, {
    minVoteCount: options.minVoteCount,
    firstYear: options.firstYear,
    lastYear: options.lastYear,
    originalLanguage: options.originalLanguage,
    signal: options.signal,
    onSlice: (slice: SliceReport) => {
      if (slice.truncated) truncatedYears.push(slice.year);
      report('discover');
    },
  });

  /**
   * Shared cursor over the discover stream. Workers pull rather than being
   * handed a precomputed list, so discovery and detail fetching overlap and a
   * slow record cannot stall the others.
   */
  const pull = async (): Promise<number | null> => {
    const next = await ids.next();
    if (next.done === true) return null;
    discovered += 1;
    return next.value.id;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (accepted.length >= options.maxItems) return;
      if (options.signal?.aborted === true) return;
      const id = await pull();
      if (id === null) return;

      try {
        const detail = await client.movieDetail(id, options.signal);
        fetched += 1;
        const mapped = toCatalogItem(detail, mapOptions);
        if (mapped.ok) {
          accepted.push(mapped.item);
        } else {
          rejections.set(
            mapped.reason,
            (rejections.get(mapped.reason) ?? 0) + 1,
          );
        }
      } catch {
        // A single unreachable record must not abandon a 20,000-item import;
        // the client has already exhausted its own retry budget by here.
        failed += 1;
      }
      if ((fetched + failed) % 100 === 0) report('detail');
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, () => worker()),
  );

  if (accepted.length === 0) {
    throw new Error(
      'TMDB import produced no usable items; keeping the previous catalog',
    );
  }

  report('commit');
  const completedAt = clock().toISOString();
  const ranked = applyWeightedRatings(accepted, options.ratingPriorVotes);
  commitCatalogVersion(database, {
    version,
    provider: TMDB_PROVIDER,
    minVoteCount: options.minVoteCount,
    poolMeanRating: poolMeanRating(accepted),
    startedAt,
    completedAt,
    imageBaseUrl,
    posterSize,
    items: ranked,
  });
  // Retiring a row is not enough to satisfy the provider's cache limit; content
  // that has fallen out of the catalog has to actually go.
  const purged = purgeRetiredCatalogItems(
    database,
    cacheCutoff(new Date(completedAt)),
  );

  return {
    version,
    provider: TMDB_PROVIDER,
    discovered,
    accepted: accepted.length,
    rejected: countRejections(rejections),
    failed,
    poolMeanRating: poolMeanRating(accepted),
    imageBaseUrl,
    posterSize,
    rejections: Object.fromEntries(rejections),
    truncatedYears,
    purged,
    cappedAtMaxItems: accepted.length >= options.maxItems,
    startedAt,
    completedAt,
  };
}

function countRejections(rejections: Map<RejectionReason, number>): number {
  let total = 0;
  for (const count of rejections.values()) total += count;
  return total;
}
