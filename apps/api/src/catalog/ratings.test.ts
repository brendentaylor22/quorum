import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrate,
  migrationsDirectory,
  openDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmdbStopError, fetchOmdbRatings } from './omdb.js';
import { attachRatings } from './ratings.js';
import { commitCatalogVersion, unrankedWriteItem } from './repository.js';

const databases: QuorumDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function freshDatabase(): QuorumDatabase {
  const database = openDatabase(
    join(mkdtempSync(join(tmpdir(), 'quorum-ratings-')), 'quorum.db'),
  );
  migrate(database, migrationsDirectory);
  databases.push(database);
  return database;
}

const now = new Date('2026-10-28T00:00:00.000Z');

function film(ref: string, weightedRating: number) {
  return { providerRef: ref, imdbId: `tt${ref}`, weightedRating };
}

const rated = { imdbRating: 8, imdbVotes: 10, rtScore: 90 };

describe('attachRatings', () => {
  it('spends the budget on the best-ranked films first', async () => {
    const lookup = vi
      .fn<(id: string) => Promise<typeof rated>>()
      .mockResolvedValue(rated);
    const { items, report } = await attachRatings(
      freshDatabase(),
      [film('1', 5), film('2', 9), film('3', 7)],
      { lookup, budget: 2, staleAfterDays: 30, now },
    );
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['tt2', 'tt3']);
    expect(report).toMatchObject({ fetched: 2, pending: 1 });
    expect(items.find((i) => i.providerRef === '1')?.rtScore).toBeNull();
  });

  it('carries stored ratings forward and skips fresh ones', async () => {
    const database = freshDatabase();
    commitCatalogVersion(database, {
      version: 'v1',
      provider: 'tmdb',
      minVoteCount: 1,
      poolMeanRating: 0,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      items: [
        {
          ...unrankedWriteItem({
            provider: 'tmdb',
            providerRef: '1',
            mediaType: 'MOVIE',
            title: 'One',
            releaseYear: 2000,
            synopsis: 's',
            runtimeMinutes: 90,
            contentRating: null,
            language: 'en',
            posterRef: '/1.jpg',
            catalogVersion: 'v1',
            sourceFetchedAt: now.toISOString(),
          }),
          imdbId: 'tt1',
          ...rated,
          ratingsFetchedAt: now.toISOString(),
        },
      ],
    });
    const lookup = vi.fn();
    const { items, report } = await attachRatings(database, [film('1', 5)], {
      lookup,
      budget: 10,
      staleAfterDays: 30,
      now,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject(rated);
    expect(report.pending).toBe(0);
  });

  it('keeps what it has when OMDb refuses further requests', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(rated)
      .mockRejectedValueOnce(new OmdbStopError('quota'));
    const { report } = await attachRatings(
      freshDatabase(),
      [film('1', 9), film('2', 8), film('3', 7)],
      { lookup, budget: 10, staleAfterDays: 30, now },
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      fetched: 1,
      pending: 2,
      stoppedEarly: true,
    });
  });

  it('leaves a failed film due and carries on', async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(rated);
    const { report } = await attachRatings(
      freshDatabase(),
      [film('1', 9), film('2', 8)],
      { lookup, budget: 10, staleAfterDays: 30, now },
    );
    expect(report).toMatchObject({ fetched: 1, failed: 1, pending: 1 });
  });
});

describe('fetchOmdbRatings', () => {
  const respond = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('reads IMDb and Rotten Tomatoes', async () => {
    const result = await fetchOmdbRatings('tt1', {
      apiKey: 'k',
      fetch: respond(200, {
        Response: 'True',
        imdbRating: '8.7',
        imdbVotes: '2,000,000',
        Ratings: [{ Source: 'Rotten Tomatoes', Value: '87%' }],
      }),
    });
    expect(result).toEqual({
      imdbRating: 8.7,
      imdbVotes: 2_000_000,
      rtScore: 87,
    });
  });

  it('treats N/A and unknown films as no rating', async () => {
    const missing = { imdbRating: null, imdbVotes: null, rtScore: null };
    expect(
      await fetchOmdbRatings('tt1', {
        apiKey: 'k',
        fetch: respond(200, { Response: 'True', imdbRating: 'N/A' }),
      }),
    ).toEqual(missing);
    expect(
      await fetchOmdbRatings('tt1', {
        apiKey: 'k',
        fetch: respond(200, { Response: 'False', Error: 'Incorrect IMDb ID.' }),
      }),
    ).toEqual(missing);
  });

  it('stops on a refused key or exhausted quota', async () => {
    await expect(
      fetchOmdbRatings('tt1', {
        apiKey: 'k',
        fetch: respond(401, {
          Response: 'False',
          Error: 'Request limit reached!',
        }),
      }),
    ).rejects.toBeInstanceOf(OmdbStopError);
  });
});
