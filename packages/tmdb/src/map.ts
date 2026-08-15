import type { CatalogItem } from '@quorum/catalog';
import { poolMeanRating, weightedRating } from './rating.js';
import type { TmdbGenre, TmdbMovieDetail } from './schemas.js';

export const TMDB_PROVIDER = 'tmdb';

/**
 * A TMDB record in the shared `CatalogItem` shape, plus the ranking and
 * feature fields the recommender needs. Extending `CatalogItem` is deliberate:
 * the compiler now enforces that the TMDB path and the fixture path stay
 * interchangeable, which is what the fixture loader's contract promises.
 */
export interface TmdbCatalogItem extends CatalogItem {
  tmdbId: number;
  imdbId: string | null;
  originalLanguage: string | null;
  voteAverage: number;
  voteCount: number;
  popularity: number;
  genres: TmdbGenre[];
  keywords: TmdbGenre[];
  directors: string[];
  topCast: string[];
}

/** A mapped item with its pool-relative ranking score resolved. */
export interface RatedCatalogItem extends TmdbCatalogItem {
  weightedRating: number;
}

export interface MapOptions {
  catalogVersion: string;
  sourceFetchedAt: string;
  minVoteCount: number;
  /** Certification regions in preference order, e.g. `['GB', 'US']`. */
  certificationRegions?: readonly string[];
  /** Restrict to these original languages; omit to accept any. */
  allowedLanguages?: readonly string[];
  topCastSize?: number;
}

export type RejectionReason =
  | 'adult'
  | 'video'
  | 'not_released'
  | 'missing_poster'
  | 'missing_synopsis'
  | 'missing_language'
  | 'unsupported_language'
  | 'missing_year'
  | 'missing_runtime'
  | 'too_few_votes';

export type MapResult =
  { ok: true; item: TmdbCatalogItem } | { ok: false; reason: RejectionReason };

/**
 * Apply the quality bar and project a TMDB detail record onto the catalog
 * shape. This is a quality filter, not personalisation — it decides whether a
 * movie is presentable at all, never whether a group would enjoy it.
 */
export function toCatalogItem(
  detail: TmdbMovieDetail,
  options: MapOptions,
): MapResult {
  if (detail.adult) return { ok: false, reason: 'adult' };
  if (detail.video) return { ok: false, reason: 'video' };
  if (detail.status !== 'Released')
    return { ok: false, reason: 'not_released' };
  if (detail.poster_path === null)
    return { ok: false, reason: 'missing_poster' };

  const synopsis = normaliseText(detail.overview);
  if (synopsis === null) return { ok: false, reason: 'missing_synopsis' };

  const language = normaliseText(detail.original_language);
  if (language === null) return { ok: false, reason: 'missing_language' };
  if (
    options.allowedLanguages !== undefined &&
    !options.allowedLanguages.includes(language)
  ) {
    return { ok: false, reason: 'unsupported_language' };
  }

  const releaseYear = parseReleaseYear(detail.release_date);
  if (releaseYear === null) return { ok: false, reason: 'missing_year' };
  if (detail.runtime === null || detail.runtime <= 0) {
    return { ok: false, reason: 'missing_runtime' };
  }
  if (detail.vote_count < options.minVoteCount) {
    return { ok: false, reason: 'too_few_votes' };
  }

  const castSize = options.topCastSize ?? 5;
  return {
    ok: true,
    item: {
      provider: TMDB_PROVIDER,
      providerRef: detail.id.toString(),
      mediaType: 'MOVIE',
      title: detail.title,
      releaseYear,
      synopsis,
      runtimeMinutes: detail.runtime,
      contentRating: certificationFor(detail, options.certificationRegions),
      language,
      // TMDB requires images be served from their CDN, so store the path and
      // build the URL from `/configuration` at render time. Never mirror it.
      posterRef: detail.poster_path,
      catalogVersion: options.catalogVersion,
      sourceFetchedAt: options.sourceFetchedAt,
      tmdbId: detail.id,
      imdbId: normaliseText(detail.imdb_id),
      originalLanguage: language,
      voteAverage: detail.vote_average,
      voteCount: detail.vote_count,
      popularity: detail.popularity,
      genres: detail.genres,
      keywords: detail.keywords.keywords,
      directors: detail.credits.crew
        .filter((member) => member.job === 'Director')
        .map((member) => member.name),
      topCast: [...detail.credits.cast]
        .sort((left, right) => left.order - right.order)
        .slice(0, castSize)
        .map((member) => member.name),
    },
  };
}

/**
 * Resolve `weightedRating` across a finished pool. The pool mean is a property
 * of the whole import, so this runs once after mapping rather than per item.
 */
export function applyWeightedRatings(
  items: readonly TmdbCatalogItem[],
  minVotes: number,
): RatedCatalogItem[] {
  const mean = poolMeanRating(items);
  return items.map((item) => ({
    ...item,
    weightedRating: weightedRating(
      item.voteAverage,
      item.voteCount,
      minVotes,
      mean,
    ),
  }));
}

function normaliseText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseReleaseYear(releaseDate: string | null): number | null {
  if (releaseDate === null) return null;
  const match = /^(\d{4})-\d{2}-\d{2}$/u.exec(releaseDate.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year > 1870 ? year : null;
}

/**
 * First non-empty certification from the preferred regions, favouring the
 * theatrical release (type 3) when a region lists several.
 */
function certificationFor(
  detail: TmdbMovieDetail,
  regions: readonly string[] = ['GB', 'US'],
): string | null {
  for (const region of regions) {
    const entry = detail.release_dates.results.find(
      (result) => result.iso_3166_1 === region,
    );
    if (entry === undefined) continue;
    const rated = entry.release_dates.filter(
      (release) => release.certification.trim() !== '',
    );
    if (rated.length === 0) continue;
    const theatrical = rated.find((release) => release.type === 3);
    return (theatrical ?? rated[0])?.certification.trim() ?? null;
  }
  return null;
}
