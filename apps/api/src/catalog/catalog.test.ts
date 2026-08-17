import {
  migrate,
  migrationsDirectory,
  openDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import {
  TmdbClient,
  applyWeightedRatings,
  type FetchLike,
  type TmdbCatalogItem,
} from '@quorum/tmdb';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listSlateCandidateIds } from '../rooms/repository.js';
import { RoomService } from '../rooms/service.js';
import {
  CATALOG_DEFAULTS,
  importOptionsFromEnvironment,
  readTmdbToken,
} from './config.js';
import { catalogVersionFor, importTmdbCatalog } from './importer.js';
import {
  TMDB_CACHE_MAX_DAYS,
  cacheCutoff,
  catalogAgeDays,
  catalogStatus,
  commitCatalogVersion,
  purgeRetiredCatalogItems,
  unrankedWriteItem,
  type CatalogWriteItem,
} from './repository.js';

/** Older than the provider cache limit relative to the tests' fixed "now". */
const OLD = '2025-01-01T00:00:00.000Z';

/** A mapped TMDB item with a chosen average and vote count. */
function detailItem(
  reference: string,
  voteAverage: number,
  voteCount: number,
): TmdbCatalogItem {
  return {
    provider: 'tmdb',
    providerRef: reference,
    mediaType: 'MOVIE',
    title: reference,
    releaseYear: 2000,
    synopsis: 'Something happens.',
    runtimeMinutes: 100,
    contentRating: '15',
    language: 'en',
    posterRef: `/${reference}.jpg`,
    catalogVersion: 'v1',
    sourceFetchedAt: '2026-08-15T00:00:00.000Z',
    tmdbId: 1,
    imdbId: null,
    originalLanguage: 'en',
    voteAverage,
    voteCount,
    popularity: 1,
    genres: [],
    keywords: [],
    directors: [],
    topCast: [],
  };
}

const databases: QuorumDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function freshDatabase(): QuorumDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-catalog-'));
  const database = openDatabase(join(directory, 'quorum.db'));
  migrate(database, migrationsDirectory);
  databases.push(database);
  return database;
}

function writeItem(
  reference: string,
  overrides: Partial<CatalogWriteItem> = {},
): CatalogWriteItem {
  return {
    provider: 'tmdb',
    providerRef: reference,
    mediaType: 'MOVIE',
    title: `Movie ${reference}`,
    releaseYear: 2000,
    synopsis: 'Something happens.',
    runtimeMinutes: 100,
    contentRating: '15',
    language: 'en',
    posterRef: `/${reference}.jpg`,
    catalogVersion: 'ignored',
    sourceFetchedAt: '2026-08-14T00:00:00.000Z',
    voteAverage: 7,
    voteCount: 1000,
    popularity: 10,
    weightedRating: 7,
    genres: [{ id: 28, name: 'Action' }],
    keywords: [{ id: 5, name: 'heist' }],
    ...overrides,
  };
}

function commit(
  database: QuorumDatabase,
  version: string,
  items: CatalogWriteItem[],
  completedAt = '2026-08-14T00:00:00.000Z',
): number {
  return commitCatalogVersion(database, {
    version,
    provider: 'tmdb',
    minVoteCount: 300,
    poolMeanRating: 6.5,
    startedAt: '2026-08-13T00:00:00.000Z',
    completedAt,
    items,
  });
}

describe('commitCatalogVersion', () => {
  it('installs a catalog and marks it current', () => {
    const database = freshDatabase();
    expect(commit(database, 'v1', [writeItem('1'), writeItem('2')])).toBe(2);

    const status = catalogStatus(database);
    expect(status.current).toMatchObject({
      version: 'v1',
      provider: 'tmdb',
      itemCount: 2,
      minVoteCount: 300,
    });
    expect(status.activeItems).toBe(2);
    expect(status.totalItems).toBe(2);
  });

  it('stores genres and keywords for later recommendation work', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1')]);
    const genres = database
      .prepare(
        `SELECT g.name AS name FROM catalog_item_genres l
           JOIN catalog_genres g ON g.id = l.genre_id`,
      )
      .all() as { name: string }[];
    const keywords = database
      .prepare(
        `SELECT k.name AS name FROM catalog_item_keywords l
           JOIN catalog_keywords k ON k.id = l.keyword_id`,
      )
      .all() as { name: string }[];
    expect(genres).toEqual([{ name: 'Action' }]);
    expect(keywords).toEqual([{ name: 'heist' }]);
  });

  it('retires items missing from a later version instead of deleting them', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1'), writeItem('2')]);
    commit(database, 'v2', [writeItem('2'), writeItem('3')]);

    const status = catalogStatus(database);
    expect(status.current?.version).toBe('v2');
    expect(status.activeItems).toBe(2);
    // The dropped movie survives, because room_items may still reference it.
    expect(status.totalItems).toBe(3);

    const retired = database
      .prepare("SELECT active FROM catalog_items WHERE provider_ref = '1'")
      .get() as { active: number };
    expect(retired.active).toBe(0);
  });

  it('keeps exactly one current version', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1')]);
    commit(database, 'v2', [writeItem('1')]);
    const rows = database
      .prepare(
        'SELECT count(*) AS count FROM catalog_versions WHERE is_current = 1',
      )
      .get() as { count: number };
    expect(rows.count).toBe(1);
  });

  it('refreshes metadata on a movie seen in both versions', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1', { title: 'Old title' })]);
    commit(database, 'v2', [
      writeItem('1', { title: 'New title', voteCount: 5000 }),
    ]);
    const row = database
      .prepare(
        "SELECT title, vote_count AS voteCount FROM catalog_items WHERE provider_ref = '1'",
      )
      .get() as { title: string; voteCount: number };
    expect(row).toEqual({ title: 'New title', voteCount: 5000 });
  });

  it('replaces taxonomy links rather than accumulating them', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1')]);
    commit(database, 'v2', [
      writeItem('1', { genres: [{ id: 18, name: 'Drama' }] }),
    ]);
    const genres = database
      .prepare(
        `SELECT g.name AS name FROM catalog_item_genres l
           JOIN catalog_genres g ON g.id = l.genre_id`,
      )
      .all() as { name: string }[];
    expect(genres).toEqual([{ name: 'Drama' }]);
  });

  it('reports no current catalog on an empty database', () => {
    const database = freshDatabase();
    expect(catalogStatus(database)).toEqual({
      current: null,
      activeItems: 0,
      totalItems: 0,
    });
    expect(catalogAgeDays(database, new Date())).toBeNull();
  });

  it('measures catalog age in whole days', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1')], '2026-08-01T00:00:00.000Z');
    expect(catalogAgeDays(database, new Date('2026-08-14T12:00:00.000Z'))).toBe(
      13,
    );
  });
});

describe('fixture seeding', () => {
  function service(database: QuorumDatabase): RoomService {
    return new RoomService({ database, secret: Buffer.alloc(32, 1) });
  }

  it('seeds the fixture when nothing is installed', () => {
    const database = freshDatabase();
    expect(service(database).seedFixtureCatalog()).toBeGreaterThanOrEqual(20);
    expect(catalogStatus(database).current?.provider).toBe('synthetic');
  });

  it('refreshes a fixture catalog on a later boot', () => {
    const database = freshDatabase();
    const instance = service(database);
    instance.seedFixtureCatalog();
    expect(instance.seedFixtureCatalog()).toBeGreaterThanOrEqual(20);
    expect(catalogStatus(database).current?.provider).toBe('synthetic');
  });

  it('never overwrites an imported catalog', () => {
    const database = freshDatabase();
    commit(database, 'tmdb-v1', [writeItem('1'), writeItem('2')]);

    // Booting again must leave the real catalog in place; seeding commits a
    // version, which would otherwise deactivate every imported row.
    expect(service(database).seedFixtureCatalog()).toBe(0);

    const status = catalogStatus(database);
    expect(status.current?.provider).toBe('tmdb');
    expect(status.current?.version).toBe('tmdb-v1');
    expect(status.activeItems).toBe(2);
  });
});

describe('rating prior', () => {
  it('keeps a hyped new release out of an all-time top slot', () => {
    // A fresh film with a stellar average on few votes, against a classic
    // with a slightly lower average on far more.
    const items = [
      detailItem('hyped', 8.9, 2000),
      detailItem('classic', 8.6, 25000),
      ...Array.from({ length: 20 }, (_, index) =>
        detailItem(`filler${index.toString()}`, 6.5, 5000),
      ),
    ];
    const ranked = applyWeightedRatings(
      items,
      CATALOG_DEFAULTS.ratingPriorVotes,
    );
    const hyped = ranked.find((entry) => entry.providerRef === 'hyped');
    const classic = ranked.find((entry) => entry.providerRef === 'classic');
    expect(classic?.weightedRating).toBeGreaterThan(hyped?.weightedRating ?? 0);
  });

  it('a low prior lets the hyped release win, which is why it is separate', () => {
    const items = [
      detailItem('hyped', 8.9, 2000),
      detailItem('classic', 8.6, 25000),
      ...Array.from({ length: 20 }, (_, index) =>
        detailItem(`filler${index.toString()}`, 6.5, 5000),
      ),
    ];
    const ranked = applyWeightedRatings(items, 300);
    const hyped = ranked.find((entry) => entry.providerRef === 'hyped');
    const classic = ranked.find((entry) => entry.providerRef === 'classic');
    expect(hyped?.weightedRating).toBeGreaterThan(classic?.weightedRating ?? 0);
  });
});

describe('provider cache limit', () => {
  it('deletes retired content past the limit', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1'), writeItem('2')], OLD);
    commit(database, 'v2', [writeItem('2')], OLD);

    expect(catalogStatus(database).totalItems).toBe(2);
    const purged = purgeRetiredCatalogItems(
      database,
      cacheCutoff(new Date('2026-08-14T00:00:00.000Z')),
    );
    expect(purged).toBe(1);
    expect(catalogStatus(database).totalItems).toBe(1);
  });

  it('keeps retired content that is still inside the limit', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1'), writeItem('2')]);
    commit(database, 'v2', [writeItem('2')]);
    const purged = purgeRetiredCatalogItems(
      database,
      cacheCutoff(new Date('2026-08-14T00:00:00.000Z')),
    );
    expect(purged).toBe(0);
  });

  it('never deletes an item a room still references', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1')], OLD);
    const itemId = (
      database.prepare('SELECT id FROM catalog_items').get() as { id: number }
    ).id;
    database
      .prepare(
        `INSERT INTO rooms (public_id, state, invite_token_hash, host_token_hash, created_at, expires_at)
         VALUES ('room', 'VOTING', 'a', 'b', ?, ?)`,
      )
      .run(OLD, '2099-01-01T00:00:00.000Z');
    database
      .prepare(
        `INSERT INTO rounds (room_id, round_number, slate_seed, catalog_version,
           strategy, eligible_count, started_at)
         VALUES (1, 1, 'seed', 'v1', 'TOP_RATED', 1, ?)`,
      )
      .run(OLD);
    database
      .prepare(
        `INSERT INTO room_items (room_id, round_id, catalog_item_id, slate_position)
         VALUES (1, 1, ?, 1)`,
      )
      .run(itemId);
    // Retire it, then try to collect it.
    commit(database, 'v2', [writeItem('other')], OLD);

    expect(
      purgeRetiredCatalogItems(
        database,
        cacheCutoff(new Date('2026-08-14T00:00:00.000Z')),
      ),
    ).toBe(0);
    expect(catalogStatus(database).totalItems).toBe(2);
  });

  it('computes the cutoff from the limit', () => {
    expect(cacheCutoff(new Date('2026-08-14T00:00:00.000Z'), 180)).toBe(
      '2026-02-15T00:00:00.000Z',
    );
    expect(TMDB_CACHE_MAX_DAYS).toBe(180);
  });
});

describe('0003 upgrade path', () => {
  it('adopts an existing fixture catalog so the room keeps serving', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-upgrade-'));
    const database = openDatabase(join(directory, 'quorum.db'));
    databases.push(database);

    // Stand the database up at the pre-ranking schema, as a Phase 2 install
    // would be, then import a fixture catalog the old way.
    database.exec(`
      CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
    `);
    for (const name of ['0001_foundation.sql', '0002_room_model.sql']) {
      database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'));
      database
        .prepare(
          'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
        )
        .run(name, '2026-01-01T00:00:00.000Z');
    }
    database
      .prepare(
        `INSERT INTO catalog_items (
           provider, provider_ref, media_type, title, catalog_version,
           source_fetched_at, imported_at
         ) VALUES ('synthetic', 'fixture-01', 'MOVIE', 'Fixture', 'synthetic-v1',
                   '1970-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    expect(migrate(database, migrationsDirectory)).toEqual([
      '0003_catalog_ranking.sql',
      '0004_rounds.sql',
      '0005_catalog_images.sql',
      '0006_slate_scores.sql',
    ]);

    const status = catalogStatus(database);
    expect(status.current?.version).toBe('synthetic-v1');
    expect(status.activeItems).toBe(1);
    expect(listSlateCandidateIds(database, 10)).toHaveLength(1);
  });
});

describe('unrankedWriteItem', () => {
  it('zeroes the ranking fields a fixture cannot supply', () => {
    const item = unrankedWriteItem({
      provider: 'synthetic',
      providerRef: 'fixture-01',
      mediaType: 'MOVIE',
      title: 'Fixture',
      releaseYear: 2020,
      synopsis: 'Synopsis',
      runtimeMinutes: 90,
      contentRating: 'PG',
      language: 'en',
      posterRef: 'fixture://poster/01',
      catalogVersion: 'synthetic-v1',
      sourceFetchedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(item).toMatchObject({
      voteAverage: 0,
      voteCount: 0,
      weightedRating: 0,
      genres: [],
      keywords: [],
    });
  });
});

describe('listSlateCandidateIds', () => {
  /** Provider references in pool order, best candidate first. */
  function poolOrder(database: QuorumDatabase, poolSize: number): string[] {
    return listSlateCandidateIds(database, poolSize).map((id) => {
      const row = database
        .prepare(
          'SELECT provider_ref AS reference FROM catalog_items WHERE id = ?',
        )
        .get(id) as { reference: string };
      return row.reference;
    });
  }

  it('returns only active items, best rated first', () => {
    const database = freshDatabase();
    commit(database, 'v1', [
      writeItem('low', { weightedRating: 5 }),
      writeItem('high', { weightedRating: 9 }),
      writeItem('mid', { weightedRating: 7 }),
    ]);
    // Vote count and year are identical here, so rating alone decides.
    expect(poolOrder(database, 10)).toEqual(['high', 'mid', 'low']);
  });

  it('puts a recent, widely seen film ahead of a marginally better classic', () => {
    const database = freshDatabase();
    commit(database, 'v1', [
      writeItem('classic', {
        weightedRating: 8.4,
        voteCount: 4000,
        releaseYear: 1955,
      }),
      writeItem('blockbuster', {
        weightedRating: 8,
        voteCount: 25_000,
        releaseYear: 2022,
      }),
      // The band the other two are normalised against.
      writeItem('floor', {
        weightedRating: 5,
        voteCount: 0,
        releaseYear: 1930,
      }),
    ]);
    expect(poolOrder(database, 10)[0]).toBe('blockbuster');
  });

  it('keeps quality dominant over reach and recency', () => {
    const database = freshDatabase();
    commit(database, 'v1', [
      writeItem('acclaimed', {
        weightedRating: 8.5,
        voteCount: 3000,
        releaseYear: 1975,
      }),
      // Newer and far more seen, but well down the rating band.
      writeItem('mediocre', {
        weightedRating: 6,
        voteCount: 60_000,
        releaseYear: 2025,
      }),
      writeItem('floor', {
        weightedRating: 5,
        voteCount: 0,
        releaseYear: 1930,
      }),
    ]);
    expect(poolOrder(database, 10)[0]).toBe('acclaimed');
  });

  it('survives a catalog with no spread to normalise against', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('only')]);
    expect(poolOrder(database, 10)).toEqual(['only']);
  });

  it('caps the pool', () => {
    const database = freshDatabase();
    commit(
      database,
      'v1',
      Array.from({ length: 10 }, (_, index) =>
        writeItem(`m${index.toString()}`, { weightedRating: index }),
      ),
    );
    expect(listSlateCandidateIds(database, 3)).toHaveLength(3);
  });

  it('excludes retired items', () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('1'), writeItem('2')]);
    commit(database, 'v2', [writeItem('2')]);
    expect(listSlateCandidateIds(database, 10)).toHaveLength(1);
  });

  it('rejects a nonsensical pool size', () => {
    const database = freshDatabase();
    expect(() => listSlateCandidateIds(database, 0)).toThrow(
      /positive integer/u,
    );
  });
});

describe('catalogVersionFor', () => {
  it('produces a sortable, filename-safe version', () => {
    expect(catalogVersionFor(new Date('2026-08-14T09:30:00.000Z'))).toBe(
      'tmdb-2026-08-14T09-30-00-000Z',
    );
  });
});

/** Canned TMDB responses keyed by path, so the importer runs offline. */
function stubTmdb(
  movies: Record<string, unknown>[],
  options: { failIds?: number[] } = {},
): TmdbClient {
  const byYear = new Map<number, Record<string, unknown>[]>();
  for (const movie of movies) {
    const year = Number(String(movie.release_date).slice(0, 4));
    byYear.set(year, [...(byYear.get(year) ?? []), movie]);
  }
  const fetchImpl: FetchLike = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/3/discover/movie') {
      const year = Number(parsed.searchParams.get('primary_release_year'));
      const results = (byYear.get(year) ?? []).map((movie) => ({
        id: movie.id,
        adult: false,
        vote_count: movie.vote_count,
      }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            results,
            total_pages: results.length === 0 ? 0 : 1,
            total_results: results.length,
          }),
          { status: 200 },
        ),
      );
    }
    const match = /^\/3\/movie\/(\d+)$/u.exec(parsed.pathname);
    if (match !== null) {
      const id = Number(match[1]);
      if (options.failIds?.includes(id) === true) {
        return Promise.resolve(new Response('', { status: 404 }));
      }
      const movie = movies.find((entry) => entry.id === id);
      return Promise.resolve(
        new Response(JSON.stringify(movie), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('', { status: 404 }));
  };
  return new TmdbClient({
    token: 'test-token',
    fetch: fetchImpl,
    requestsPerSecond: 10_000,
    burst: 100,
    sleep: () => Promise.resolve(),
  });
}

function tmdbMovie(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Movie ${id.toString()}`,
    original_language: 'en',
    overview: 'A thing happens to someone.',
    release_date: '2020-05-01',
    runtime: 110,
    status: 'Released',
    poster_path: `/${id.toString()}.jpg`,
    popularity: 20,
    vote_average: 7.5,
    vote_count: 1000,
    genres: [{ id: 28, name: 'Action' }],
    keywords: { keywords: [{ id: 9, name: 'chase' }] },
    credits: { cast: [], crew: [] },
    release_dates: { results: [] },
    ...overrides,
  };
}

const importOptions = {
  minVoteCount: 300,
  firstYear: 2020,
  lastYear: 2020,
  concurrency: 2,
  maxItems: 100,
  now: () => new Date('2026-08-14T00:00:00.000Z'),
};

describe('importTmdbCatalog', () => {
  it('imports, ranks, and installs a catalog', async () => {
    const database = freshDatabase();
    const client = stubTmdb([
      tmdbMovie(1, { vote_average: 8.5, vote_count: 20000 }),
      tmdbMovie(2, { vote_average: 6, vote_count: 500 }),
      tmdbMovie(3, { vote_average: 7, vote_count: 1500 }),
    ]);

    const report = await importTmdbCatalog(database, client, importOptions);

    expect(report).toMatchObject({
      provider: 'tmdb',
      discovered: 3,
      accepted: 3,
      rejected: 0,
      failed: 0,
      purged: 0,
      cappedAtMaxItems: false,
    });
    expect(catalogStatus(database).activeItems).toBe(3);

    // The best-evidenced high rating must lead the pool.
    const [best] = listSlateCandidateIds(database, 10);
    const row = database
      .prepare(
        'SELECT provider_ref AS reference FROM catalog_items WHERE id = ?',
      )
      .get(best) as { reference: string };
    expect(row.reference).toBe('1');
  });

  it('counts rejections by reason without failing the import', async () => {
    const database = freshDatabase();
    const client = stubTmdb([
      tmdbMovie(1),
      tmdbMovie(2, { poster_path: null }),
      tmdbMovie(3, { vote_count: 10 }),
      tmdbMovie(4, { status: 'Rumored' }),
    ]);

    const report = await importTmdbCatalog(database, client, importOptions);

    expect(report.accepted).toBe(1);
    expect(report.rejected).toBe(3);
    expect(report.rejections).toMatchObject({
      missing_poster: 1,
      too_few_votes: 1,
      not_released: 1,
    });
  });

  it('survives an unreachable record', async () => {
    const database = freshDatabase();
    const client = stubTmdb([tmdbMovie(1), tmdbMovie(2)], { failIds: [2] });
    const report = await importTmdbCatalog(database, client, importOptions);
    expect(report).toMatchObject({ accepted: 1, failed: 1 });
    expect(catalogStatus(database).activeItems).toBe(1);
  });

  it('keeps the previous catalog when an import yields nothing', async () => {
    const database = freshDatabase();
    commit(database, 'v1', [writeItem('keeper')]);
    const client = stubTmdb([tmdbMovie(1, { poster_path: null })]);

    await expect(
      importTmdbCatalog(database, client, importOptions),
    ).rejects.toThrow(/no usable items/u);

    const status = catalogStatus(database);
    expect(status.current?.version).toBe('v1');
    expect(status.activeItems).toBe(1);
  });

  it('honours the item ceiling', async () => {
    const database = freshDatabase();
    const client = stubTmdb(
      Array.from({ length: 10 }, (_, index) => tmdbMovie(index + 1)),
    );
    const report = await importTmdbCatalog(database, client, {
      ...importOptions,
      concurrency: 1,
      maxItems: 4,
    });
    expect(report.accepted).toBeLessThanOrEqual(4);
    expect(report.accepted).toBeGreaterThan(0);
    // Hitting the ceiling drops the oldest films, so it must be visible.
    expect(report.cappedAtMaxItems).toBe(true);
  });

  it('reports progress as it goes', async () => {
    const database = freshDatabase();
    const client = stubTmdb([tmdbMovie(1)]);
    const phases: string[] = [];
    await importTmdbCatalog(database, client, {
      ...importOptions,
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(phases).toContain('discover');
    expect(phases).toContain('commit');
  });
});

describe('readTmdbToken', () => {
  it('reads the token from a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-token-'));
    const path = join(directory, 'token');
    writeFileSync(path, 'secret-token\n');
    expect(readTmdbToken({ TMDB_TOKEN_FILE: path })).toBe('secret-token');
  });

  it('rejects an empty token file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-token-'));
    const path = join(directory, 'token');
    writeFileSync(path, '   \n');
    expect(() => readTmdbToken({ TMDB_TOKEN_FILE: path })).toThrow(/is empty/u);
  });

  it('falls back to an inline variable', () => {
    expect(readTmdbToken({ TMDB_TOKEN: 'inline' })).toBe('inline');
  });

  it('refuses to run without a credential', () => {
    expect(() => readTmdbToken({})).toThrow(/TMDB_READ_ACCESS_TOKEN_FILE/u);
  });

  it('accepts the documented credential names', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-token-'));
    const path = join(directory, 'token');
    writeFileSync(path, 'from-file\n');
    expect(readTmdbToken({ TMDB_READ_ACCESS_TOKEN_FILE: path })).toBe(
      'from-file',
    );
    expect(readTmdbToken({ TMDB_READ_ACCESS_TOKEN: 'inline' })).toBe('inline');
  });
});

describe('importOptionsFromEnvironment', () => {
  const now = new Date('2026-08-14T00:00:00.000Z');

  it('defaults to a bounded, quality-gated sweep', () => {
    expect(importOptionsFromEnvironment({}, now)).toMatchObject({
      minVoteCount: CATALOG_DEFAULTS.minVoteCount,
      ratingPriorVotes: CATALOG_DEFAULTS.ratingPriorVotes,
      firstYear: CATALOG_DEFAULTS.firstYear,
      lastYear: 2026,
      concurrency: CATALOG_DEFAULTS.concurrency,
      maxItems: CATALOG_DEFAULTS.maxItems,
      certificationRegions: ['GB', 'US'],
      allowedLanguages: undefined,
      originalLanguage: undefined,
    });
  });

  it('reads overrides', () => {
    expect(
      importOptionsFromEnvironment(
        {
          QUORUM_CATALOG_MIN_VOTES: '1000',
          QUORUM_CATALOG_FIRST_YEAR: '1970',
          QUORUM_CATALOG_LAST_YEAR: '2000',
          QUORUM_CATALOG_CONCURRENCY: '4',
          QUORUM_CATALOG_MAX_ITEMS: '50',
          QUORUM_CATALOG_LANGUAGES: 'en, fr',
          QUORUM_CATALOG_REGIONS: 'GB',
          QUORUM_CATALOG_ORIGINAL_LANGUAGE: 'EN',
        },
        now,
      ),
    ).toEqual({
      minVoteCount: 1000,
      ratingPriorVotes: CATALOG_DEFAULTS.ratingPriorVotes,
      firstYear: 1970,
      lastYear: 2000,
      concurrency: 4,
      maxItems: 50,
      allowedLanguages: ['en', 'fr'],
      certificationRegions: ['GB'],
      originalLanguage: 'en',
    });
  });

  it('rejects a non-numeric setting', () => {
    expect(() =>
      importOptionsFromEnvironment({ QUORUM_CATALOG_MIN_VOTES: 'lots' }, now),
    ).toThrow(/positive integer/u);
  });

  it('rejects an inverted year window', () => {
    expect(() =>
      importOptionsFromEnvironment(
        { QUORUM_CATALOG_FIRST_YEAR: '2020', QUORUM_CATALOG_LAST_YEAR: '2010' },
        now,
      ),
    ).toThrow(/after the last year/u);
  });
});
