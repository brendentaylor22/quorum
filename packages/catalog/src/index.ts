import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Fixture catalog source for Phase 2. TMDB import lands in Phase 4 and must
 * produce the same `CatalogItem` shape so nothing downstream changes.
 */
export interface CatalogItem {
  provider: string;
  providerRef: string;
  mediaType: 'MOVIE';
  title: string;
  releaseYear: number | null;
  synopsis: string | null;
  runtimeMinutes: number | null;
  contentRating: string | null;
  language: string | null;
  posterRef: string | null;
  catalogVersion: string;
  sourceFetchedAt: string;
}

const fixtureMovieSchema = z.object({
  fixture_id: z.string().min(1),
  title: z.string().min(1),
  year: z.number().int().nullable().default(null),
  synopsis: z.string().nullable().default(null),
  runtime_minutes: z.number().int().positive().nullable().default(null),
  content_rating: z.string().nullable().default(null),
  language: z.string().min(2).nullable().default(null),
  poster_ref: z.string().min(1).nullable().default(null),
  adult: z.boolean().default(false),
});

const fixtureFileSchema = z.object({
  fixture_version: z.string().min(1),
  source: z.string().min(1),
  notice: z.string().optional(),
  movies: z.array(fixtureMovieSchema),
});

export const defaultFixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/catalog/movies.json',
);

export function fixtureCatalogPath(): string {
  return process.env.QUORUM_CATALOG_FIXTURE_PATH ?? defaultFixturePath;
}

/**
 * Load the fixture catalog, dropping anything that fails the basic quality
 * bar: adult content, or missing poster, synopsis, language, or release year.
 * This is deliberately not personalisation.
 */
export function loadFixtureCatalog(path = fixtureCatalogPath()): CatalogItem[] {
  const parsed = fixtureFileSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  const fetchedAt = new Date(0).toISOString();
  const items = parsed.movies
    .filter(
      (movie) =>
        !movie.adult &&
        movie.poster_ref !== null &&
        movie.synopsis !== null &&
        movie.language !== null &&
        movie.year !== null,
    )
    .map((movie): CatalogItem => ({
      provider: parsed.source,
      providerRef: movie.fixture_id,
      mediaType: 'MOVIE',
      title: movie.title,
      releaseYear: movie.year,
      synopsis: movie.synopsis,
      runtimeMinutes: movie.runtime_minutes,
      contentRating: movie.content_rating,
      language: movie.language,
      posterRef: movie.poster_ref,
      catalogVersion: parsed.fixture_version,
      sourceFetchedAt: fetchedAt,
    }));

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.providerRef)) {
      throw new Error(`Duplicate catalog reference: ${item.providerRef}`);
    }
    seen.add(item.providerRef);
  }
  return items;
}

/** Deterministic 32-bit stream derived from a server-generated seed. */
function seededOrder(seed: string, index: number): bigint {
  const digest = createHash('sha256')
    .update(`${seed}:${index.toString()}`)
    .digest();
  return digest.readBigUInt64BE(0);
}

/**
 * Choose `size` items without replacement using a server-generated seed. The
 * seed is persisted with the room so a slate can be reproduced exactly.
 */
export function selectSlate<T>(
  candidates: readonly T[],
  size: number,
  seed: string,
): T[] {
  if (candidates.length < size) {
    throw new Error(
      `Catalog has ${candidates.length.toString()} usable items; ${size.toString()} required`,
    );
  }
  return candidates
    .map((item, index) => ({ item, order: seededOrder(seed, index) }))
    .sort((left, right) => (left.order < right.order ? -1 : 1))
    .slice(0, size)
    .map((entry) => entry.item);
}
