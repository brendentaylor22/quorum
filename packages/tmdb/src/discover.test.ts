import { describe, expect, it } from 'vitest';
import type { QueryValue, TmdbClient } from './client.js';
import {
  changedMovieIds,
  discoverMovies,
  type SliceReport,
} from './discover.js';
import type { TmdbChangesPage, TmdbDiscoverPage } from './schemas.js';

interface DiscoverStub {
  client: TmdbClient;
  queries: Record<string, QueryValue>[];
}

/**
 * Minimal stand-in for the client: `discoverMovies` only ever calls the two
 * page methods, so a structural stub keeps these tests off the network.
 */
function stubClient(
  pages: (query: Record<string, QueryValue>) => TmdbDiscoverPage,
): DiscoverStub {
  const queries: Record<string, QueryValue>[] = [];
  const client = {
    discoverMovies: (query: Record<string, QueryValue>) => {
      queries.push(query);
      return Promise.resolve(pages(query));
    },
  } as unknown as TmdbClient;
  return { client, queries };
}

function page(
  results: { id: number; vote_count?: number; adult?: boolean }[],
  totalPages: number,
  totalResults: number,
  pageNumber = 1,
): TmdbDiscoverPage {
  return {
    page: pageNumber,
    total_pages: totalPages,
    total_results: totalResults,
    results: results.map((result) => ({
      id: result.id,
      adult: result.adult ?? false,
      vote_count: result.vote_count ?? 500,
    })),
  };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe('discoverMovies', () => {
  it('rejects an inverted year window', async () => {
    const { client } = stubClient(() => page([], 0, 0));
    await expect(
      collect(
        discoverMovies(client, {
          minVoteCount: 200,
          firstYear: 2020,
          lastYear: 2010,
        }),
      ),
    ).rejects.toThrow(/inverted/u);
  });

  it('rejects non-integer year bounds', async () => {
    const { client } = stubClient(() => page([], 0, 0));
    await expect(
      collect(
        discoverMovies(client, {
          minVoteCount: 200,
          firstYear: 2020.5,
          lastYear: 2021,
        }),
      ),
    ).rejects.toThrow(/integers/u);
  });

  it('slices by year, newest first, and applies the vote floor', async () => {
    const { client, queries } = stubClient((query) =>
      page([{ id: Number(query.primary_release_year) }], 1, 1),
    );
    const found = await collect(
      discoverMovies(client, {
        minVoteCount: 250,
        firstYear: 2020,
        lastYear: 2022,
      }),
    );
    expect(found.map((movie) => movie.id)).toEqual([2022, 2021, 2020]);
    expect(queries).toHaveLength(3);
    expect(queries[0]?.primary_release_year).toBe(2022);
    expect(queries[0]?.['vote_count.gte']).toBe(250);
    expect(queries[0]?.include_adult).toBe(false);
  });

  it('pages through a slice until total_pages is exhausted', async () => {
    const { client, queries } = stubClient((query) => {
      const number = Number(query.page);
      return page([{ id: number }], 3, 60, number);
    });
    const found = await collect(
      discoverMovies(client, {
        minVoteCount: 200,
        firstYear: 2020,
        lastYear: 2020,
      }),
    );
    expect(found.map((movie) => movie.id)).toEqual([1, 2, 3]);
    expect(queries.map((query) => query.page)).toEqual([1, 2, 3]);
  });

  it('stops at the page ceiling and reports the slice as truncated', async () => {
    const reports: SliceReport[] = [];
    const { client, queries } = stubClient((query) =>
      page([{ id: Number(query.page) }], 40, 800, Number(query.page)),
    );
    await collect(
      discoverMovies(client, {
        minVoteCount: 200,
        firstYear: 2020,
        lastYear: 2020,
        maxPagesPerSlice: 2,
        onSlice: (slice) => reports.push(slice),
      }),
    );
    expect(queries).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      year: 2020,
      pagesRead: 2,
      totalResults: 800,
      truncated: true,
    });
  });

  it('does not flag a slice that fits inside the ceiling', async () => {
    const reports: SliceReport[] = [];
    const { client } = stubClient(() => page([{ id: 1 }], 1, 5));
    await collect(
      discoverMovies(client, {
        minVoteCount: 200,
        firstYear: 2020,
        lastYear: 2020,
        onSlice: (slice) => reports.push(slice),
      }),
    );
    expect(reports[0]?.truncated).toBe(false);
  });

  it('skips adult records and repeats across slices', async () => {
    const { client } = stubClient(() =>
      page([{ id: 1 }, { id: 2, adult: true }, { id: 1 }], 1, 3),
    );
    const found = await collect(
      discoverMovies(client, {
        minVoteCount: 200,
        firstYear: 2019,
        lastYear: 2020,
      }),
    );
    expect(found.map((movie) => movie.id)).toEqual([1]);
  });

  it('passes an original-language filter through when set', async () => {
    const { client, queries } = stubClient(() => page([], 1, 0));
    await collect(
      discoverMovies(client, {
        minVoteCount: 200,
        firstYear: 2020,
        lastYear: 2020,
        originalLanguage: 'en',
      }),
    );
    expect(queries[0]?.with_original_language).toBe('en');
  });
});

describe('changedMovieIds', () => {
  function changesClient(pages: TmdbChangesPage[]): TmdbClient {
    return {
      movieChanges: (_start: string, _end: string, pageNumber = 1) =>
        Promise.resolve(pages[pageNumber - 1] ?? pages[0]),
    } as unknown as TmdbClient;
  }

  it('pages through changes and drops adult and duplicate ids', async () => {
    const client = changesClient([
      { page: 1, total_pages: 2, results: [{ id: 1, adult: false }] },
      {
        page: 2,
        total_pages: 2,
        results: [
          { id: 1, adult: false },
          { id: 2, adult: true },
          { id: 3, adult: null },
        ],
      },
    ]);
    await expect(
      collect(changedMovieIds(client, '2026-08-01', '2026-08-07')),
    ).resolves.toEqual([1, 3]);
  });
});
