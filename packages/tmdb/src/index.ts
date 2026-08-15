/**
 * TMDB metadata source for the Quorum catalog.
 *
 * The package is pure I/O plus mapping: it fetches, validates, and projects
 * TMDB records onto the shared `CatalogItem` shape. It never touches the
 * database, so the importer can stage and swap a catalog version on its own
 * terms, and every piece here stays testable without network access.
 *
 * Credentials only ever reach this package from a server-side secret. The
 * token is sent as a bearer header so it cannot leak through a URL, log line,
 * or error message.
 */
export {
  TMDB_ATTRIBUTION,
  TMDB_IMAGE_BASE_URL,
  posterUrl,
  preferredPosterSize,
  type PosterUrlOptions,
} from './attribution.js';

export {
  TMDB_BASE_URL,
  TMDB_MAX_PAGES,
  TMDB_RESULTS_PER_PAGE,
  TmdbClient,
  TmdbError,
  redactUrl,
  type FetchLike,
  type QueryValue,
  type RetryInfo,
  type TmdbClientOptions,
} from './client.js';

export {
  TMDB_CHANGES_MAX_DAYS,
  changedMovieIds,
  discoverMovies,
  type DiscoverOptions,
  type DiscoveredMovie,
  type SliceReport,
} from './discover.js';

export {
  DEFAULT_RATING_PRIOR_VOTES,
  TMDB_PROVIDER,
  applyWeightedRatings,
  toCatalogItem,
  type MapOptions,
  type MapResult,
  type RatedCatalogItem,
  type RejectionReason,
  type TmdbCatalogItem,
} from './map.js';

export { poolMeanRating, weightedRating } from './rating.js';

export {
  RateLimiter,
  realSleep,
  type RateLimiterOptions,
  type Sleep,
} from './rate-limit.js';

export {
  changesPageSchema,
  configurationSchema,
  discoverPageSchema,
  genreListSchema,
  movieDetailSchema,
  type TmdbChangesPage,
  type TmdbConfiguration,
  type TmdbDiscoverMovie,
  type TmdbDiscoverPage,
  type TmdbGenre,
  type TmdbMovieDetail,
} from './schemas.js';
