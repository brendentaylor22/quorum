import { describe, expect, it } from 'vitest';
import { applyWeightedRatings, toCatalogItem, type MapOptions } from './map.js';
import { movieDetailSchema, type TmdbMovieDetail } from './schemas.js';

const options: MapOptions = {
  catalogVersion: 'tmdb-2026-08-14',
  sourceFetchedAt: '2026-08-14T00:00:00.000Z',
  minVoteCount: 200,
};

/** Build a detail record through the schema so defaults match a real fetch. */
function detail(overrides: Record<string, unknown> = {}): TmdbMovieDetail {
  return movieDetailSchema.parse({
    id: 603,
    title: 'The Matrix',
    original_language: 'en',
    overview: 'A hacker learns the truth about his reality.',
    release_date: '1999-03-30',
    runtime: 136,
    status: 'Released',
    poster_path: '/matrix.jpg',
    popularity: 82.5,
    vote_average: 8.2,
    vote_count: 24000,
    genres: [{ id: 28, name: 'Action' }],
    keywords: { keywords: [{ id: 1, name: 'dystopia' }] },
    credits: {
      cast: [
        { id: 6384, name: 'Keanu Reeves', order: 0 },
        { id: 2975, name: 'Laurence Fishburne', order: 1 },
      ],
      crew: [
        { id: 9339, name: 'Lana Wachowski', job: 'Director' },
        { id: 1, name: 'Someone Else', job: 'Editor' },
      ],
    },
    release_dates: {
      results: [
        {
          iso_3166_1: 'GB',
          release_dates: [
            { certification: '12', type: 5 },
            { certification: '15', type: 3 },
          ],
        },
        { iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] },
      ],
    },
    ...overrides,
  });
}

function expectRejected(
  overrides: Record<string, unknown>,
  reason: string,
): void {
  const result = toCatalogItem(detail(overrides), options);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('toCatalogItem', () => {
  it('projects a usable record onto the catalog shape', () => {
    const result = toCatalogItem(detail(), options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toMatchObject({
      provider: 'tmdb',
      providerRef: '603',
      mediaType: 'MOVIE',
      title: 'The Matrix',
      releaseYear: 1999,
      runtimeMinutes: 136,
      language: 'en',
      posterRef: '/matrix.jpg',
      catalogVersion: 'tmdb-2026-08-14',
      tmdbId: 603,
      voteCount: 24000,
    });
    expect(result.item.directors).toEqual(['Lana Wachowski']);
    expect(result.item.topCast).toEqual(['Keanu Reeves', 'Laurence Fishburne']);
    expect(result.item.genres).toEqual([{ id: 28, name: 'Action' }]);
    expect(result.item.keywords).toEqual([{ id: 1, name: 'dystopia' }]);
  });

  it('stores the raw poster path so images come from the TMDB CDN', () => {
    const result = toCatalogItem(detail(), options);
    expect(result.ok && result.item.posterRef).toBe('/matrix.jpg');
    expect(result.ok && result.item.posterRef).not.toContain('http');
  });

  it('prefers the theatrical certification from the first listed region', () => {
    const result = toCatalogItem(detail(), options);
    expect(result.ok && result.item.contentRating).toBe('15');
  });

  it('falls back to the next region when the first has no certification', () => {
    const result = toCatalogItem(
      detail({
        release_dates: {
          results: [
            {
              iso_3166_1: 'GB',
              release_dates: [{ certification: '', type: 3 }],
            },
            {
              iso_3166_1: 'US',
              release_dates: [{ certification: 'R', type: 3 }],
            },
          ],
        },
      }),
      options,
    );
    expect(result.ok && result.item.contentRating).toBe('R');
  });

  it('uses the first rated entry when no theatrical release is listed', () => {
    const result = toCatalogItem(
      detail({
        release_dates: {
          results: [
            {
              iso_3166_1: 'GB',
              release_dates: [{ certification: 'PG', type: 4 }],
            },
          ],
        },
      }),
      options,
    );
    expect(result.ok && result.item.contentRating).toBe('PG');
  });

  it('reports no certification rather than inventing one', () => {
    const result = toCatalogItem(
      detail({ release_dates: { results: [] } }),
      options,
    );
    expect(result.ok && result.item.contentRating).toBeNull();
  });

  it('honours a caller-supplied region preference', () => {
    const result = toCatalogItem(detail(), {
      ...options,
      certificationRegions: ['US'],
    });
    expect(result.ok && result.item.contentRating).toBe('R');
  });

  it('caps the cast list and orders it by billing', () => {
    const result = toCatalogItem(
      detail({
        credits: {
          cast: [
            { id: 3, name: 'Third', order: 2 },
            { id: 1, name: 'First', order: 0 },
            { id: 2, name: 'Second', order: 1 },
          ],
          crew: [],
        },
      }),
      { ...options, topCastSize: 2 },
    );
    expect(result.ok && result.item.topCast).toEqual(['First', 'Second']);
  });

  it('survives a record with no appended blocks', () => {
    const bare = movieDetailSchema.parse({
      id: 1,
      title: 'Bare',
      original_language: 'en',
      overview: 'Something happens.',
      release_date: '2010-01-01',
      runtime: 90,
      status: 'Released',
      poster_path: '/bare.jpg',
      vote_count: 500,
    });
    const result = toCatalogItem(bare, options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.keywords).toEqual([]);
      expect(result.item.directors).toEqual([]);
    }
  });

  it('applies the quality bar', () => {
    expectRejected({ adult: true }, 'adult');
    expectRejected({ video: true }, 'video');
    expectRejected({ status: 'Post Production' }, 'not_released');
    expectRejected({ poster_path: null }, 'missing_poster');
    expectRejected({ overview: '   ' }, 'missing_synopsis');
    expectRejected({ original_language: null }, 'missing_language');
    expectRejected({ release_date: '' }, 'missing_year');
    expectRejected({ runtime: 0 }, 'missing_runtime');
    expectRejected({ vote_count: 199 }, 'too_few_votes');
  });

  it('rejects an unsupported original language when a list is configured', () => {
    const result = toCatalogItem(detail({ original_language: 'ko' }), {
      ...options,
      allowedLanguages: ['en'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_language');
  });

  it('rejects an implausible release year', () => {
    expectRejected({ release_date: '1800-01-01' }, 'missing_year');
  });
});

describe('applyWeightedRatings', () => {
  it('pulls a thin record toward the pool mean and leaves a heavy one alone', () => {
    // A realistic pool: the mean has to come from somewhere other than the two
    // records under test, or every item is its own baseline.
    const filler = Array.from({ length: 10 }, (_, index) =>
      detail({ id: 100 + index, vote_count: 1000, vote_average: 6 }),
    );
    const items = [
      detail({ id: 1, vote_count: 12, vote_average: 9.5 }),
      detail({ id: 2, vote_count: 20000, vote_average: 8.2 }),
      ...filler,
    ]
      .map((record) => toCatalogItem(record, { ...options, minVoteCount: 10 }))
      .flatMap((result) => (result.ok ? [result.item] : []));

    const rated = applyWeightedRatings(items, 1000);
    const thin = rated.find((item) => item.tmdbId === 1);
    const heavy = rated.find((item) => item.tmdbId === 2);

    expect(thin?.weightedRating).toBeLessThan(8.5);
    expect(heavy?.weightedRating).toBeCloseTo(8.2, 1);
    // The thin 9.5 must not outrank the well-evidenced 8.2.
    expect(thin?.weightedRating).toBeLessThan(heavy?.weightedRating ?? 0);
  });

  it('returns an empty pool unchanged', () => {
    expect(applyWeightedRatings([], 1000)).toEqual([]);
  });
});
