import { readFileSync } from 'node:fs';
import type { ImportOptions } from './importer.js';

/**
 * Import configuration, all from the environment so the refresh container can
 * be tuned without a rebuild. Defaults target a first import of a few thousand
 * well-evidenced movies rather than the whole of TMDB.
 */
export const CATALOG_DEFAULTS = {
  minVoteCount: 600,
  ratingPriorVotes: 3000,
  firstYear: 1930,
  concurrency: 12,
  maxItems: 20_000,
  certificationRegions: ['GB', 'US'] as const,
} as const;

export type CatalogEnvironment = Record<string, string | undefined>;

/**
 * Read the TMDB read access token from a file.
 *
 * A file keeps the credential out of the process table and out of
 * `docker inspect`; `docs/phase-0/tmdb-use-review.md` requires exactly this in
 * production. The inline variable exists for local development only.
 */
export function readTmdbToken(
  environment: CatalogEnvironment = process.env,
): string {
  const path =
    environment.TMDB_READ_ACCESS_TOKEN_FILE ?? environment.TMDB_TOKEN_FILE;
  if (path !== undefined && path.trim() !== '') {
    const token = readFileSync(path, 'utf8').trim();
    if (token === '') throw new Error(`TMDB token file is empty: ${path}`);
    return token;
  }
  const inline = (
    environment.TMDB_READ_ACCESS_TOKEN ?? environment.TMDB_TOKEN
  )?.trim();
  if (inline !== undefined && inline !== '') return inline;
  throw new Error(
    'Set TMDB_READ_ACCESS_TOKEN_FILE to a file holding the TMDB read access token',
  );
}

/**
 * Override the TMDB endpoint. Only for pointing the importer at a local stub
 * during testing; production leaves it unset and uses the real API.
 */
export function tmdbBaseUrl(
  environment: CatalogEnvironment = process.env,
): string | undefined {
  const value = environment.TMDB_BASE_URL?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === 0 ? undefined : entries;
}

export function importOptionsFromEnvironment(
  environment: CatalogEnvironment = process.env,
  now: Date = new Date(),
): Omit<ImportOptions, 'signal' | 'now' | 'onProgress'> {
  const firstYear = positiveInteger(
    environment.QUORUM_CATALOG_FIRST_YEAR,
    CATALOG_DEFAULTS.firstYear,
    'QUORUM_CATALOG_FIRST_YEAR',
  );
  const lastYear = positiveInteger(
    environment.QUORUM_CATALOG_LAST_YEAR,
    now.getUTCFullYear(),
    'QUORUM_CATALOG_LAST_YEAR',
  );
  if (firstYear > lastYear) {
    throw new Error('QUORUM_CATALOG_FIRST_YEAR is after the last year');
  }
  const languages = list(environment.QUORUM_CATALOG_LANGUAGES);
  const regions = list(environment.QUORUM_CATALOG_REGIONS);
  const originalLanguage =
    environment.QUORUM_CATALOG_ORIGINAL_LANGUAGE?.trim().toLowerCase();

  return {
    minVoteCount: positiveInteger(
      environment.QUORUM_CATALOG_MIN_VOTES,
      CATALOG_DEFAULTS.minVoteCount,
      'QUORUM_CATALOG_MIN_VOTES',
    ),
    ratingPriorVotes: positiveInteger(
      environment.QUORUM_CATALOG_RATING_PRIOR,
      CATALOG_DEFAULTS.ratingPriorVotes,
      'QUORUM_CATALOG_RATING_PRIOR',
    ),
    firstYear,
    lastYear,
    concurrency: positiveInteger(
      environment.QUORUM_CATALOG_CONCURRENCY,
      CATALOG_DEFAULTS.concurrency,
      'QUORUM_CATALOG_CONCURRENCY',
    ),
    maxItems: positiveInteger(
      environment.QUORUM_CATALOG_MAX_ITEMS,
      CATALOG_DEFAULTS.maxItems,
      'QUORUM_CATALOG_MAX_ITEMS',
    ),
    allowedLanguages: languages,
    certificationRegions: regions ?? CATALOG_DEFAULTS.certificationRegions,
    originalLanguage:
      originalLanguage === undefined || originalLanguage === ''
        ? undefined
        : originalLanguage,
  };
}
