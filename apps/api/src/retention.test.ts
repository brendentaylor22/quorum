import {
  REQUEST_HEADER,
  type CreateRoomResponse,
  type RoomView,
} from '@quorum/contracts';
import {
  migrate,
  migrationsDirectory,
  openDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { RateLimiter } from './rate-limit.js';
import { resolveSweepIntervalMs, startRetentionSweep } from './retention.js';
import { RoomService } from './rooms/service.js';

const apps: FastifyInstance[] = [];
const databases: QuorumDatabase[] = [];
const HOUR_MS = 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  for (const database of databases.splice(0)) database.close();
});

interface Clocked {
  service: RoomService;
  database: QuorumDatabase;
  advance: (ms: number) => void;
}

function createService(): Clocked {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-retention-'));
  const database = openDatabase(join(directory, 'quorum.db'));
  databases.push(database);
  migrate(database, migrationsDirectory);
  let clock = Date.parse('2026-08-17T12:00:00.000Z');
  const service = new RoomService({
    database,
    secret: Buffer.from('a'.repeat(64), 'hex'),
    now: () => new Date(clock),
  });
  service.seedFixtureCatalog();
  return {
    service,
    database,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** A room with a real participant, so a purge has something to take with it. */
function populatedRoom(service: RoomService): { publicId: string } {
  const created = service.createRoom();
  service.join(created.inviteToken, 'Ada', true);
  return { publicId: created.roomId };
}

describe('resolveSweepIntervalMs', () => {
  it('defaults to a quarter-hour sweep', () => {
    expect(resolveSweepIntervalMs({})).toBe(15 * 60 * 1000);
  });

  it('accepts an operator interval and refuses a nonsensical one', () => {
    expect(
      resolveSweepIntervalMs({ QUORUM_RETENTION_SWEEP_MINUTES: '5' }),
    ).toBe(5 * 60 * 1000);
    expect(() =>
      resolveSweepIntervalMs({ QUORUM_RETENTION_SWEEP_MINUTES: '0' }),
    ).toThrow();
    expect(() =>
      resolveSweepIntervalMs({ QUORUM_RETENTION_SWEEP_MINUTES: 'often' }),
    ).toThrow();
  });
});

describe('applyRetention', () => {
  it('expires a room past its window without deleting it yet', () => {
    const { service, advance } = createService();
    populatedRoom(service);

    advance(25 * HOUR_MS);
    const result = service.applyRetention();

    expect(result.expired).toBe(1);
    expect(result.purged).toBe(0);
    // The tombstone is deliberate: an expired link and a link that never
    // existed must be indistinguishable, including by timing.
    expect(service.retentionCounts().expiredRooms).toBe(1);
  });

  it('deletes the tombstone once its own window is up, and the votes with it', () => {
    const { service, advance } = createService();
    populatedRoom(service);
    expect(service.retentionCounts().participants).toBe(1);

    advance(25 * HOUR_MS);
    service.applyRetention();
    advance(25 * HOUR_MS);
    const result = service.applyRetention();

    expect(result.purged).toBe(1);
    const counts = service.retentionCounts();
    expect(counts.rooms).toBe(0);
    // The cascade is the point: no orphan participant, exposure, or
    // interaction survives the room it belonged to.
    expect(counts.participants).toBe(0);
    expect(counts.exposures).toBe(0);
    expect(counts.interactions).toBe(0);
  });

  it('purges without any request traffic, which lazy expiry could not', () => {
    const { service, advance } = createService();
    populatedRoom(service);

    // No API request is ever made here. Before the scheduled sweep existed,
    // this room would have sat on disk forever.
    advance(50 * HOUR_MS);
    service.applyRetention();
    service.applyRetention();

    expect(service.retentionCounts().rooms).toBe(0);
  });

  it('leaves a live room and its data alone', () => {
    const { service, advance } = createService();
    populatedRoom(service);

    advance(23 * HOUR_MS);
    const result = service.applyRetention();

    expect(result).toEqual({ expired: 0, purged: 0 });
    expect(service.retentionCounts().participants).toBe(1);
  });

  it('records that a purge happened without recording what was purged', () => {
    const { service, database, advance } = createService();
    const room = populatedRoom(service);

    advance(50 * HOUR_MS);
    service.applyRetention();
    service.applyRetention();

    const events = database
      .prepare('SELECT event, detail, room_id AS roomId FROM audit_events')
      .all() as {
      event: string;
      detail: string | null;
      roomId: number | null;
    }[];
    expect(events.some((event) => event.event === 'rooms.purged')).toBe(true);
    // Nothing left in the audit trail may identify the room it deleted, or the
    // record outlives the deletion it records.
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(room.publicId);
  });
});

describe('purgeRoom', () => {
  it('deletes one named room outright for a deletion request', () => {
    const { service } = createService();
    const first = populatedRoom(service);
    populatedRoom(service);

    expect(service.purgeRoom(first.publicId)).toBe(true);

    const counts = service.retentionCounts();
    expect(counts.rooms).toBe(1);
    expect(counts.participants).toBe(1);
  });

  it('reports a room that was not there rather than claiming success', () => {
    const { service } = createService();

    expect(service.purgeRoom('not-a-room')).toBe(false);
  });
});

describe('the scheduled sweep', () => {
  it('runs once immediately, so a restart applies retention at boot', () => {
    const { service, advance } = createService();
    populatedRoom(service);
    advance(25 * HOUR_MS);

    const sweep = startRetentionSweep({ service, intervalMs: 60_000 });
    try {
      expect(service.retentionCounts().expiredRooms).toBe(1);
      advance(25 * HOUR_MS);
      expect(sweep.runOnce()).toEqual({ expired: 0, purged: 1 });
    } finally {
      sweep.stop();
    }
  });
});

describe('through the API', () => {
  it('answers an expired link exactly like one that never existed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-retention-api-'));
    let clock = Date.now();
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
      rateLimiter: new RateLimiter({ scale: 0 }),
      now: () => new Date(clock),
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { [REQUEST_HEADER]: '1' },
    });
    const room = created.json<CreateRoomResponse>();

    const live = await app.inject({
      method: 'GET',
      url: `/api/invites/${room.inviteToken}`,
    });
    expect(live.statusCode).toBe(200);
    expect(live.json<RoomView>().state).toBe('LOBBY');

    clock += 25 * HOUR_MS;
    const expired = await app.inject({
      method: 'GET',
      url: `/api/invites/${room.inviteToken}`,
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/invites/never-was-a-room-here-at-all',
    });

    expect(expired.statusCode).toBe(unknown.statusCode);
    expect(expired.json()).toEqual(unknown.json());
  });
});
