import { z } from 'zod';

/**
 * Response schemas for the TMDB endpoints the importer uses. Every response is
 * validated before it reaches the catalog: TMDB is an external source and a
 * shape change must fail the import loudly rather than write partial rows.
 *
 * Unknown keys are stripped, so TMDB adding fields never breaks an import.
 */

export const imageConfigurationSchema = z.object({
  secure_base_url: z.url(),
  poster_sizes: z.array(z.string().min(1)).min(1),
});

export const configurationSchema = z.object({
  images: imageConfigurationSchema,
});

export const genreSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
});

export const genreListSchema = z.object({
  genres: z.array(genreSchema),
});

/** Summary shape returned by `/discover/movie` and `/movie/changes` pages. */
export const discoverMovieSchema = z.object({
  id: z.number().int(),
  adult: z.boolean().default(false),
  vote_count: z.number().int().nonnegative().default(0),
});

export const discoverPageSchema = z.object({
  page: z.number().int().positive(),
  results: z.array(discoverMovieSchema),
  total_pages: z.number().int().nonnegative(),
  total_results: z.number().int().nonnegative(),
});

export const changedMovieSchema = z.object({
  id: z.number().int(),
  adult: z.boolean().nullable().default(false),
});

export const changesPageSchema = z.object({
  page: z.number().int().positive(),
  results: z.array(changedMovieSchema),
  total_pages: z.number().int().nonnegative(),
});

const keywordSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
});

const castSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  order: z.number().int().nonnegative().default(0),
});

const crewSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  job: z.string().default(''),
});

const releaseDateSchema = z.object({
  certification: z.string().default(''),
  /** TMDB release types; 3 is theatrical, 4 is digital, 5 is physical. */
  type: z.number().int().default(0),
});

const releaseDateRegionSchema = z.object({
  iso_3166_1: z.string().min(2),
  release_dates: z.array(releaseDateSchema).default([]),
});

/**
 * `/movie/{id}?append_to_response=keywords,credits,release_dates`.
 *
 * The appended blocks are optional: TMDB omits them for some records, and a
 * missing keyword list must not discard an otherwise usable movie.
 */
export const movieDetailSchema = z.object({
  id: z.number().int(),
  imdb_id: z.string().nullable().default(null),
  title: z.string().min(1),
  original_title: z.string().default(''),
  original_language: z.string().nullable().default(null),
  overview: z.string().nullable().default(null),
  release_date: z.string().nullable().default(null),
  runtime: z.number().int().nullable().default(null),
  adult: z.boolean().default(false),
  video: z.boolean().default(false),
  status: z.string().default(''),
  poster_path: z.string().nullable().default(null),
  popularity: z.number().nonnegative().default(0),
  vote_average: z.number().nonnegative().default(0),
  vote_count: z.number().int().nonnegative().default(0),
  genres: z.array(genreSchema).default([]),
  keywords: z
    .object({ keywords: z.array(keywordSchema).default([]) })
    .default({ keywords: [] }),
  credits: z
    .object({
      cast: z.array(castSchema).default([]),
      crew: z.array(crewSchema).default([]),
    })
    .default({ cast: [], crew: [] }),
  release_dates: z
    .object({ results: z.array(releaseDateRegionSchema).default([]) })
    .default({ results: [] }),
});

export type TmdbConfiguration = z.infer<typeof configurationSchema>;
export type TmdbGenre = z.infer<typeof genreSchema>;
export type TmdbDiscoverMovie = z.infer<typeof discoverMovieSchema>;
export type TmdbDiscoverPage = z.infer<typeof discoverPageSchema>;
export type TmdbChangesPage = z.infer<typeof changesPageSchema>;
export type TmdbMovieDetail = z.infer<typeof movieDetailSchema>;
