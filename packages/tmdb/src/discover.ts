import {
  TMDB_MAX_PAGES,
  TMDB_RESULTS_PER_PAGE,
  type QueryValue,
  type TmdbClient,
} from './client.js';

export interface DiscoverOptions {
  /** Quality floor. Below a few hundred votes a rating is mostly noise. */
  minVoteCount: number;
  /** Inclusive release-year window, sliced so no query hits the page cap. */
  firstYear: number;
  lastYear: number;
  originalLanguage?: string | undefined;
  /** Pages to read per slice; TMDB refuses to page beyond 500 regardless. */
  maxPagesPerSlice?: number;
  signal?: AbortSignal | undefined;
  onSlice?: (slice: SliceReport) => void;
}

export interface SliceReport {
  year: number;
  totalResults: number;
  totalPages: number;
  pagesRead: number;
  /** True when the slice held more results than paging could reach. */
  truncated: boolean;
}

export interface DiscoveredMovie {
  id: number;
  voteCount: number;
}

/**
 * Enumerate candidate movie IDs, one release year at a time.
 *
 * `/discover` returns at most 500 pages, so a single unsliced sweep silently
 * drops everything past 10,000 results. Slicing by year keeps each query well
 * inside the cap and makes any remaining truncation visible through
 * `onSlice` instead of vanishing.
 */
export async function* discoverMovies(
  client: TmdbClient,
  options: DiscoverOptions,
): AsyncGenerator<DiscoveredMovie> {
  const { firstYear, lastYear } = options;
  if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear)) {
    throw new Error('Discover year bounds must be integers');
  }
  if (firstYear > lastYear) {
    throw new Error('Discover year window is inverted');
  }
  const maxPages = Math.min(
    TMDB_MAX_PAGES,
    options.maxPagesPerSlice ?? TMDB_MAX_PAGES,
  );
  const seen = new Set<number>();

  for (let year = lastYear; year >= firstYear; year -= 1) {
    let totalPages = 1;
    let totalResults = 0;
    let pagesRead = 0;

    for (let page = 1; page <= Math.min(totalPages, maxPages); page += 1) {
      const query: Record<string, QueryValue> = {
        include_adult: false,
        include_video: false,
        // Ascending vote count keeps paging stable: popular records churn
        // least at the tail, so a shifting head cannot skip a whole page.
        sort_by: 'vote_count.asc',
        'vote_count.gte': options.minVoteCount,
        primary_release_year: year,
        page,
      };
      if (options.originalLanguage !== undefined) {
        query.with_original_language = options.originalLanguage;
      }

      const result = await client.discoverMovies(query, options.signal);
      totalPages = result.total_pages;
      totalResults = result.total_results;
      pagesRead += 1;

      for (const movie of result.results) {
        if (movie.adult || seen.has(movie.id)) continue;
        seen.add(movie.id);
        yield { id: movie.id, voteCount: movie.vote_count };
      }
    }

    options.onSlice?.({
      year,
      totalResults,
      totalPages,
      pagesRead,
      truncated: totalResults > maxPages * TMDB_RESULTS_PER_PAGE,
    });
  }
}

/**
 * Movie IDs changed within a window, for incremental refreshes. TMDB only
 * serves 14 days of change history, so callers must fall back to a full sweep
 * when the last import is older than that.
 */
export const TMDB_CHANGES_MAX_DAYS = 14;

export async function* changedMovieIds(
  client: TmdbClient,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): AsyncGenerator<number> {
  let totalPages = 1;
  const seen = new Set<number>();
  for (let page = 1; page <= Math.min(totalPages, TMDB_MAX_PAGES); page += 1) {
    const result = await client.movieChanges(startDate, endDate, page, signal);
    totalPages = result.total_pages;
    for (const movie of result.results) {
      if (movie.adult === true || seen.has(movie.id)) continue;
      seen.add(movie.id);
      yield movie.id;
    }
  }
}
