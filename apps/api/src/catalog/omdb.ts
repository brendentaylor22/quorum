import type { FetchLike } from '@quorum/tmdb';
import { z } from 'zod';

export const OMDB_BASE_URL = 'https://www.omdbapi.com/';

/** What OMDb knows about one film. Every field is null when it has no value. */
export interface ExternalRatings {
  imdbRating: number | null;
  imdbVotes: number | null;
  /** Rotten Tomatoes Tomatometer, 0-100. */
  rtScore: number | null;
}

/**
 * OMDb refused every further request: the key is wrong or the daily quota is
 * spent. Distinct from a per-film failure because retrying the next film is
 * pointless, so the caller stops and keeps what it has.
 */
export class OmdbStopError extends Error {}

export interface OmdbOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

const responseSchema = z.object({
  Response: z.string(),
  Error: z.string().optional(),
  imdbRating: z.string().optional(),
  imdbVotes: z.string().optional(),
  Ratings: z
    .array(z.object({ Source: z.string(), Value: z.string() }))
    .default([]),
});

/**
 * Look one film up by IMDb id.
 *
 * OMDb only accepts the key as a query parameter, so the URL is never logged
 * or put in an error message. A film OMDb does not know yields all-null
 * ratings rather than an error, so it is recorded as looked up.
 */
export async function fetchOmdbRatings(
  imdbId: string,
  options: OmdbOptions,
  signal?: AbortSignal,
): Promise<ExternalRatings> {
  const url = new URL(options.baseUrl ?? OMDB_BASE_URL);
  url.searchParams.set('apikey', options.apiKey);
  url.searchParams.set('i', imdbId);
  const response = await (options.fetch ?? fetch)(url.toString(), {
    ...(signal === undefined ? {} : { signal }),
  });

  if (response.status === 401) {
    throw new OmdbStopError('OMDb refused the request (bad key or quota)');
  }
  if (!response.ok) {
    throw new Error(`OMDb returned HTTP ${response.status.toString()}`);
  }
  const body = responseSchema.parse(await response.json());
  if (body.Response !== 'True') {
    if (/limit|api key/iu.test(body.Error ?? '')) {
      throw new OmdbStopError(`OMDb refused the request: ${body.Error ?? ''}`);
    }
    return { imdbRating: null, imdbVotes: null, rtScore: null };
  }

  const tomatoes = body.Ratings.find(
    (entry) => entry.Source === 'Rotten Tomatoes',
  );
  const rt = /^(\d{1,3})%$/u.exec(tomatoes?.Value ?? '');
  return {
    imdbRating: numberOrNull(body.imdbRating),
    imdbVotes: numberOrNull(body.imdbVotes?.replaceAll(',', '')),
    rtScore: rt === null ? null : Number(rt[1]),
  };
}

/** OMDb writes a missing value as the string "N/A". */
function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === 'N/A') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
