import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  type CreateRoomResponse,
  type ErrorResponse,
  type InstanceInfo,
} from '@quorum/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

describe('operator-only room creation', () => {
  it('refuses the public endpoint and still honours an invite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-closed-'));
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
    });
    apps.push(app);

    // Minted before the gate closes, standing in for the CLI's `create-room`:
    // it is the same service call, reached from the shell instead of the wire.
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { [REQUEST_HEADER]: '1' },
      })
    ).json<CreateRoomResponse>();

    vi.stubEnv('QUORUM_ROOM_CREATION', 'operator');

    const refused = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { [REQUEST_HEADER]: '1' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<ErrorResponse>().error).toBe('room_creation_disabled');

    // The mode is policy, not a secret, so the client can render a notice
    // rather than a button that fails.
    const instance = await app.inject({ method: 'GET', url: '/api/instance' });
    expect(instance.json<InstanceInfo>().roomCreation).toBe('operator');

    // Closing creation must not close the room already minted: the invite is
    // what friends were sent, and the host link is what the operator holds.
    const joined = await app.inject({
      method: 'POST',
      url: `/api/invites/${created.inviteToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Ada' },
    });
    expect(joined.statusCode).toBe(201);

    const host = await app.inject({
      method: 'POST',
      url: `/api/host/${created.hostToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Grace' },
    });
    expect(host.statusCode).toBe(201);

    // Only once: the first caller to open the host link is the host, and a
    // second one is refused rather than quietly made a second host.
    const second = await app.inject({
      method: 'POST',
      url: `/api/host/${created.hostToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Imposter' },
    });
    expect(second.statusCode).toBe(409);
  });
});
