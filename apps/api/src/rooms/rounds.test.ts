import {
  migrate,
  migrationsDirectory,
  openDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitCatalogVersion,
  type CatalogWriteItem,
} from '../catalog/repository.js';
import * as repository from './repository.js';
import { RoomService } from './service.js';

/** Assert a value the test has already established, without a bare `!`. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${what} to exist`);
  }
  return value;
}

const databases: QuorumDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * A catalog wide enough for two full rounds, split across three genres so the
 * recommender has something to prefer and something to avoid.
 */
function catalogItem(index: number): CatalogWriteItem {
  const genre = index % 3;
  return {
    provider: 'tmdb',
    providerRef: `m${index.toString()}`,
    mediaType: 'MOVIE',
    title: `Movie ${index.toString()}`,
    releaseYear: 1990 + (index % 30),
    synopsis: 'Something happens.',
    runtimeMinutes: 100,
    contentRating: '15',
    language: 'en',
    posterRef: `/m${index.toString()}.jpg`,
    catalogVersion: 'ignored',
    sourceFetchedAt: '2026-08-15T00:00:00.000Z',
    voteAverage: 8,
    voteCount: 5000,
    popularity: 10,
    // Descending, so pool order is stable and predictable.
    weightedRating: 10 - index / 1000,
    genres: [{ id: genre, name: `Genre ${genre.toString()}` }],
    keywords: [{ id: 100 + (index % 5), name: `kw${(index % 5).toString()}` }],
  };
}

function setup(catalogSize = 120): {
  service: RoomService;
  database: QuorumDatabase;
} {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-rounds-'));
  const database = openDatabase(join(directory, 'quorum.db'));
  migrate(database, migrationsDirectory);
  databases.push(database);
  commitCatalogVersion(database, {
    version: 'v1',
    provider: 'tmdb',
    minVoteCount: 300,
    poolMeanRating: 7,
    startedAt: '2026-08-15T00:00:00.000Z',
    completedAt: '2026-08-15T00:00:00.000Z',
    items: Array.from({ length: catalogSize }, (_, index) =>
      catalogItem(index),
    ),
  });
  return {
    service: new RoomService({ database, secret: Buffer.alloc(32, 3) }),
    database,
  };
}

interface Player {
  publicId: string;
  row: repository.ParticipantRow;
}

function openRoom(service: RoomService, database: QuorumDatabase) {
  const created = service.createRoom();
  const host = service.joinAsHost(created.hostToken, 'Host');
  const guest = service.join(created.inviteToken, 'Guest', false);
  const players: Player[] = [host, guest].map((joined) => {
    const row = database
      .prepare(
        `SELECT p.id AS id, p.room_id AS roomId, p.public_id AS publicId,
                p.display_name AS displayName, p.is_host AS isHost,
                p.joined_at AS joinedAt, 0 AS confirmedCount
           FROM participants p WHERE p.public_id = ?`,
      )
      .get(joined.participantId) as Omit<
      repository.ParticipantRow,
      'isHost'
    > & { isHost: number };
    return {
      publicId: joined.participantId,
      row: { ...row, isHost: Boolean(row.isHost) },
    };
  });
  return { created, players };
}

/**
 * Vote through the whole of the current round. `like` decides each swipe from
 * the item's genre, so a group can express a consistent taste.
 */
function voteRound(
  service: RoomService,
  database: QuorumDatabase,
  roomPublicId: string,
  players: Player[],
  like: (genreId: number, player: Player) => boolean,
): void {
  for (const player of players) {
    for (;;) {
      const room = repository.findRoomByPublicId(database, roomPublicId);
      if (room?.state !== 'VOTING') break;
      const view = service.view(room, {
        participant: player.row,
        isHost: player.row.isHost,
      });
      if (view.card === null) break;
      const genre = database
        .prepare(
          `SELECT g.provider_ref AS ref
             FROM catalog_items c
             JOIN catalog_item_genres l ON l.catalog_item_id = c.id
             JOIN catalog_genres g ON g.id = l.genre_id
            WHERE c.provider_ref = ?`,
        )
        .get(view.card.item.catalogItemId) as { ref: string } | undefined;
      service.swipe(
        room,
        player.row,
        view.card.exposureId,
        like(Number(genre?.ref ?? 0), player) ? 'RIGHT' : 'LEFT',
      );
    }
  }
}

describe('poster URLs', () => {
  function withImages(base: string | null): {
    service: RoomService;
    database: QuorumDatabase;
  } {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-poster-'));
    const database = openDatabase(join(directory, 'quorum.db'));
    migrate(database, migrationsDirectory);
    databases.push(database);
    commitCatalogVersion(database, {
      version: 'v1',
      provider: 'tmdb',
      minVoteCount: 300,
      poolMeanRating: 7,
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:00:00.000Z',
      imageBaseUrl: base,
      posterSize: 'w500',
      items: Array.from({ length: 40 }, (_, index) => catalogItem(index)),
    });
    return {
      service: new RoomService({ database, secret: Buffer.alloc(32, 3) }),
      database,
    };
  }

  it('builds a CDN URL from the stored path and image configuration', () => {
    const { service, database } = withImages('https://image.tmdb.org/t/p/');
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const view = service.view(room, {
      participant: must(players[0], 'host').row,
      isHost: true,
    });
    expect(view.card?.item.posterUrl).toMatch(
      /^https:\/\/image\.tmdb\.org\/t\/p\/w500\/m\d+\.jpg$/u,
    );
    // The raw reference stays available and is never a URL.
    expect(view.card?.item.posterRef).toMatch(/^\/m\d+\.jpg$/u);
  });

  it('yields no URL when the catalog carries no image configuration', () => {
    const { service, database } = withImages(null);
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const view = service.view(room, {
      participant: must(players[0], 'host').row,
      isHost: true,
    });
    expect(view.card?.item.posterUrl).toBeNull();
  });

  it('never fabricates a URL for a fixture reference', () => {
    const { service, database } = withImages('https://image.tmdb.org/t/p/');
    // A fixture-style reference is not a provider path.
    database
      .prepare("UPDATE catalog_items SET image_ref = 'fixture://poster/01'")
      .run();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const view = service.view(room, {
      participant: must(players[0], 'host').row,
      isHost: true,
    });
    expect(view.card?.item.posterUrl).toBeNull();
  });
});

describe('multi-round rooms', () => {
  it('runs round one from the top-rated pool', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const round = repository.currentRound(database, room.id);
    expect(round).toMatchObject({
      roundNumber: 1,
      strategy: 'TOP_RATED',
      eligibleCount: 2,
    });
    const view = service.view(room, {
      participant: must(players[0], 'host').row,
      isHost: true,
    });
    expect(view.round).toMatchObject({ roundNumber: 1, slateSize: 20 });
    expect(view.canContinue).toBe(false);
  });

  it('completes a round once every member has answered its slate', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(
      service,
      database,
      created.roomId,
      players,
      (genre) => genre === 0,
    );

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    expect(room.state).toBe('COMPLETE');
    const results = service.results(room);
    expect(results.roundNumber).toBe(1);
    expect(results.strategy).toBe('TOP_RATED');
    expect(results.items).toHaveLength(20);
    expect(results.completedRounds).toEqual([1]);
  });

  it('opens a recommended second round the group has not seen', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(
      service,
      database,
      created.roomId,
      players,
      (genre) => genre === 0,
    );

    const beforeRoom = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const firstSlate = new Set(
      repository.listRoomCatalogItemIds(database, beforeRoom.id),
    );
    expect(
      service.view(beforeRoom, {
        participant: must(players[0], 'host').row,
        isHost: true,
      }).canContinue,
    ).toBe(true);

    service.continueVoting(created.roomId, created.hostToken);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    expect(room.state).toBe('VOTING');
    const round = repository.currentRound(database, room.id);
    expect(round).toMatchObject({
      roundNumber: 2,
      strategy: 'RECOMMENDED',
      algorithmVersion: 'quorum-recommend-v1',
    });

    const slate = repository.listSlate(database, must(round, 'round').id);
    expect(slate).toHaveLength(20);
    // Nothing from round one may come back.
    for (const entry of slate) {
      expect(firstSlate.has(entry.catalogItemId)).toBe(false);
    }
    // Every pick carries an explanation.
    for (const entry of slate) {
      expect(entry.reason).not.toBeNull();
    }
    // Scored picks keep the number that chose them, so a round can be judged
    // against what the recommender predicted. Exploration slots carry none.
    const scored = slate.filter((entry) => entry.score !== null);
    expect(scored.length).toBeGreaterThan(0);
    for (const entry of scored) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  it('steers the second round toward what the group liked', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    // Everyone likes genre 0 and rejects the rest.
    voteRound(
      service,
      database,
      created.roomId,
      players,
      (genre) => genre === 0,
    );
    service.continueVoting(created.roomId, created.hostToken);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const round = repository.currentRound(database, room.id);
    const slate = repository.listSlate(database, must(round, 'round').id);
    const genres = slate.map((entry) => Number(entry.providerRef.slice(1)) % 3);
    const counts = [0, 1, 2].map(
      (genre) => genres.filter((entry) => entry === genre).length,
    );
    const preferred = counts[0] ?? 0;
    // The liked genre must lead clearly, well above an even three-way split...
    expect(preferred).toBeGreaterThan(counts[1] ?? 0);
    expect(preferred).toBeGreaterThan(counts[2] ?? 0);
    expect(preferred).toBeGreaterThanOrEqual(slate.length * 0.4);
    // ...but the diversity cap and exploration must still leave variety.
    expect(preferred).toBeLessThan(slate.length);
    expect(new Set(genres).size).toBeGreaterThan(1);
  });

  it('resets progress and refreezes membership for the new round', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => true);
    service.continueVoting(created.roomId, created.hostToken);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const view = service.view(room, {
      participant: must(players[0], 'host').row,
      isHost: true,
    });
    expect(view.you?.confirmedCount).toBe(0);
    expect(view.you?.complete).toBe(false);
    expect(view.round?.roundNumber).toBe(2);
    expect(view.completedRounds).toEqual([1]);
  });

  it("keeps each round's results readable and separate", () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(
      service,
      database,
      created.roomId,
      players,
      (genre) => genre === 0,
    );
    service.continueVoting(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => false);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const first = service.results(room, 1);
    const second = service.results(room, 2);

    expect(first.roundNumber).toBe(1);
    expect(first.strategy).toBe('TOP_RATED');
    expect(second.roundNumber).toBe(2);
    expect(second.strategy).toBe('RECOMMENDED');
    // Round two was rejected wholesale; round one was not.
    expect(second.items.every((entry) => entry.yes === 0)).toBe(true);
    expect(first.items.some((entry) => entry.yes > 0)).toBe(true);
    // Default results follow the latest completed round.
    expect(service.results(room).roundNumber).toBe(2);
    expect(second.completedRounds).toEqual([1, 2]);
  });

  it('refuses another round while voting is still open', () => {
    const { service, database } = setup();
    const { created } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    expect(() =>
      service.continueVoting(created.roomId, created.hostToken),
    ).toThrow(/still open/u);
  });

  it('refuses another round when too few unseen movies remain', () => {
    // 30 items: enough for round one, not for a second full slate.
    const { service, database } = setup(30);
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => true);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    expect(
      service.view(room, {
        participant: must(players[0], 'host').row,
        isHost: true,
      }).canContinue,
    ).toBe(false);
    expect(() =>
      service.continueVoting(created.roomId, created.hostToken),
    ).toThrow(/unseen movies/u);
  });

  it('hides the continue action from a non-host', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => true);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    const guest = must(players[1], 'guest');
    expect(
      service.view(room, { participant: guest.row, isHost: false }).canContinue,
    ).toBe(false);
  });

  it('closes a second round early without disturbing the first', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => true);
    service.continueVoting(created.roomId, created.hostToken);
    service.close(created.roomId, created.hostToken);

    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    expect(room.state).toBe('COMPLETE');
    expect(service.results(room, 1).closedEarly).toBe(false);
    expect(service.results(room, 2).closedEarly).toBe(true);
    // An unanswered round still counts non-responses against the denominator.
    expect(service.results(room, 2).items[0]?.eligible).toBe(2);
  });

  it('answers not found for a round that does not exist', () => {
    const { service, database } = setup();
    const { created, players } = openRoom(service, database);
    service.start(created.roomId, created.hostToken);
    voteRound(service, database, created.roomId, players, () => true);
    const room = must(
      repository.findRoomByPublicId(database, created.roomId),
      'room',
    );
    expect(() => service.results(room, 99)).toThrow(/Not found/u);
  });
});
