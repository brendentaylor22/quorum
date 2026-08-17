import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  type CreateRoomResponse,
} from '@quorum/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('health endpoints', () => {
  it('reports liveness and readiness', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const app = await buildApp({ databasePath: join(directory, 'quorum.db') });
    apps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('returns not found without built static assets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(
      404,
    );
  });
});

describe('request logging', () => {
  it('never writes a capability token to the log', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const lines: string[] = [];
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      // No static assets, so a client capability path falls through to the
      // 404 handler rather than the SPA fallback. That is the path that used
      // to leak: Fastify's default handler logs the raw URL in a message
      // string, which no serializer can reach. A machine that happened to
      // have `apps/web/dist` built never exercised it.
      staticDirectory: join(directory, 'missing'),
      logger: true,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString('utf8'));
          callback();
        },
      }),
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { [REQUEST_HEADER]: '1' },
    });
    const { inviteToken, hostToken, roomId } =
      created.json<CreateRoomResponse>();

    // Every shape that puts a secret on the wire: token in the path, token in
    // the header, session token in a cookie.
    await app.inject({ method: 'GET', url: `/api/invites/${inviteToken}` });
    await app.inject({ method: 'GET', url: `/api/host/${hostToken}` });
    await app.inject({
      method: 'POST',
      url: `/api/invites/${inviteToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Ada' },
    });
    await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}`,
      headers: { [REQUEST_HEADER]: '1', [HOST_TOKEN_HEADER]: hostToken },
    });
    await app.inject({ method: 'GET', url: `/join/${inviteToken}` });
    // A mistyped path carrying a real capability: no route matches, so only
    // the 404 handler decides whether the token reaches the log.
    await app.inject({
      method: 'GET',
      url: `/api/invites/${inviteToken}/nonsense`,
    });
    await app.inject({ method: 'GET', url: `/host/${hostToken}/typo` });

    const log = lines.join('');
    expect(log).not.toBe('');
    expect(log).not.toContain(inviteToken);
    expect(log).not.toContain(hostToken);
    // The route shape still survives, or the log would be useless.
    expect(log).toContain('/api/host/[redacted]');
  });
});
