import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  sessionCookieName,
  type CreateRoomResponse,
} from '@quorum/contracts';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { RateLimiter } from './rate-limit.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface Harness {
  app: FastifyInstance;
  advance: (ms: number) => void;
}

async function createApp(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-limits-'));
  let clock = Date.now();
  const app = await buildApp({
    databasePath: join(directory, 'quorum.db'),
    staticDirectory: join(directory, 'missing'),
    rateLimiter: new RateLimiter({ now: () => clock }),
  });
  apps.push(app);
  return {
    app,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function createRoom(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { [REQUEST_HEADER]: '1' },
  });
}

describe('room creation limits', () => {
  it('stops a cheap room-creation flood and says when to come back', async () => {
    const { app } = await createApp();

    expect((await createRoom(app)).statusCode).toBe(201);
    expect((await createRoom(app)).statusCode).toBe(201);

    const refused = await createRoom(app);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({
      error: 'rate_limited',
      message: 'Too many requests',
    });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('caps a source at ten rooms a day however patiently it waits', async () => {
    const { app, advance } = await createApp();

    let created = 0;
    // Well past the hour rule, so only the daily cap can bind.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await createRoom(app);
      if (response.statusCode === 201) created += 1;
      advance(31 * 60 * 1000);
    }

    expect(created).toBe(10);
  });
});

describe('room-scoped limits', () => {
  it('charges reads to the session, so devices on one address do not starve each other', async () => {
    const { app } = await createApp();
    const room = (await createRoom(app)).json<CreateRoomResponse>();

    const sessions: string[] = [];
    for (const name of ['Ada', 'Grace', 'Katherine', 'Dorothy']) {
      const joined = await app.inject({
        method: 'POST',
        url: `/api/invites/${room.inviteToken}/join`,
        headers: { [REQUEST_HEADER]: '1' },
        payload: { displayName: name },
      });
      expect(joined.statusCode).toBe(201);
      const cookie = joined.cookies.find(
        (entry) => entry.name === sessionCookieName(room.roomId),
      );
      sessions.push(cookie?.value ?? '');
    }

    // Each of the four polls its own budget. Keyed by address alone, the
    // fourth device would have been refused long before this.
    for (const session of sessions) {
      for (let poll = 0; poll < 9; poll += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/rooms/${room.roomId}`,
          cookies: { [sessionCookieName(room.roomId)]: session },
        });
        expect(response.statusCode).toBe(200);
      }
    }
  });

  it('still refuses one session that polls far beyond a real client', async () => {
    const { app } = await createApp();
    const room = (await createRoom(app)).json<CreateRoomResponse>();
    const joined = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Ada' },
    });
    const session =
      joined.cookies.find(
        (entry) => entry.name === sessionCookieName(room.roomId),
      )?.value ?? '';

    let refused = 0;
    for (let poll = 0; poll < 80; poll += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/rooms/${room.roomId}`,
        cookies: { [sessionCookieName(room.roomId)]: session },
      });
      if (response.statusCode === 429) refused += 1;
    }

    expect(refused).toBeGreaterThan(0);
  });

  it('limits host mutations without touching participant budgets', async () => {
    const { app } = await createApp();
    const room = (await createRoom(app)).json<CreateRoomResponse>();

    let refusedHost = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/rooms/${room.roomId}/close`,
        headers: {
          [REQUEST_HEADER]: '1',
          [HOST_TOKEN_HEADER]: room.hostToken,
        },
      });
      if (response.statusCode === 429) refusedHost += 1;
    }
    expect(refusedHost).toBeGreaterThan(0);

    // A participant joining is a different policy and a different key.
    const joined = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Ada' },
    });
    expect(joined.statusCode).toBe(201);
  });
});

describe('what the limiter must not break', () => {
  it('lets twenty people join one room from one address', async () => {
    const { app } = await createApp();
    const room = (await createRoom(app)).json<CreateRoomResponse>();

    for (let index = 0; index < 20; index += 1) {
      const joined = await app.inject({
        method: 'POST',
        url: `/api/invites/${room.inviteToken}/join`,
        headers: { [REQUEST_HEADER]: '1' },
        payload: { displayName: `Player ${index.toString()}` },
      });
      expect(joined.statusCode).toBe(201);
    }
  });

  it('lets a full lobby poll the invite while waiting', async () => {
    const { app, advance } = await createApp();
    const room = (await createRoom(app)).json<CreateRoomResponse>();

    // Twenty join screens polling every three seconds for a minute: 400
    // requests from one address, all of them honest.
    for (let round = 0; round < 20; round += 1) {
      for (let device = 0; device < 20; device += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/invites/${room.inviteToken}`,
        });
        expect(response.statusCode).toBe(200);
      }
      advance(3000);
    }
  });

  it('leaves health checks alone, so a limit cannot look like an outage', async () => {
    const { app } = await createApp();

    for (let probe = 0; probe < 200; probe += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
