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
import { buildApp, resolveTrustProxy } from './app.js';

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

  it('opens creation on the operator hostname only, never on a forwarded one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-operator-host-'));
    // Trusting a proxy is what every proxied deployment does, and it is what
    // makes this test worth having: Fastify would resolve `request.hostname`
    // from `X-Forwarded-Host`, which a caller on the public hostname controls.
    vi.stubEnv('QUORUM_TRUST_PROXY', 'true');
    vi.stubEnv('QUORUM_ROOM_CREATION', 'operator');
    vi.stubEnv('QUORUM_OPERATOR_HOSTNAME', 'start.quorum.example.org');
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
    });
    apps.push(app);

    const create = async (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { [REQUEST_HEADER]: '1', ...headers },
      });

    // The hostname friends were sent. Closed, as it was before.
    expect((await create({ host: 'quorum.example.org' })).statusCode).toBe(403);

    // The same hostname, now claiming to be the protected one. The identity
    // proxy sits in front of `start.`, so believing this header would hand
    // room creation to anyone who can type it.
    const spoofed = await create({
      host: 'quorum.example.org',
      'x-forwarded-host': 'start.quorum.example.org',
    });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json<ErrorResponse>().error).toBe('room_creation_disabled');

    // Addressed to the protected hostname, which means it came through the
    // proxy guarding it.
    const allowed = await create({ host: 'start.quorum.example.org' });
    expect(allowed.statusCode).toBe(201);

    // And the landing page agrees with the door, per hostname.
    const closed = await app.inject({
      method: 'GET',
      url: '/api/instance',
      headers: { host: 'quorum.example.org' },
    });
    expect(closed.json<InstanceInfo>().roomCreation).toBe('operator');
    const open = await app.inject({
      method: 'GET',
      url: '/api/instance',
      headers: { host: 'start.quorum.example.org' },
    });
    expect(open.json<InstanceInfo>().roomCreation).toBe('public');
  });
});

describe('resolveTrustProxy', () => {
  it('defaults to trusting nobody', () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ QUORUM_TRUST_PROXY: '' })).toBe(false);
    expect(resolveTrustProxy({ QUORUM_TRUST_PROXY: 'false' })).toBe(false);
  });

  it('takes `true` and a list of addresses', () => {
    expect(resolveTrustProxy({ QUORUM_TRUST_PROXY: 'true' })).toBe(true);
    expect(
      resolveTrustProxy({ QUORUM_TRUST_PROXY: '172.16.0.0/12, 10.0.0.1' }),
    ).toEqual(['172.16.0.0/12', '10.0.0.1']);
  });

  it('refuses a hop count rather than pretending to honour it', () => {
    // GHSA-3m5p-2c4r-xxw2: a count cannot identify the peer, so a direct
    // caller can forge enough hops to be believed. Fastify ignores a number
    // now; passing one through would only hide that from the operator.
    expect(resolveTrustProxy({ QUORUM_TRUST_PROXY: '1' })).toBe(false);
    expect(resolveTrustProxy({ QUORUM_TRUST_PROXY: ' 2 ' })).toBe(false);
  });

  it('warns at boot about a hop count, because nothing else would', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-hops-'));
    const lines: string[] = [];
    vi.stubEnv('QUORUM_TRUST_PROXY', '1');
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
      logger: true,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    });
    apps.push(app);

    expect(lines.join('')).toContain('QUORUM_TRUST_PROXY');
  });
});

describe('operator hostname configuration', () => {
  it('warns at boot when its links would point where nobody can follow', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-operator-warn-'));
    const lines: string[] = [];
    vi.stubEnv('QUORUM_ROOM_CREATION', 'operator');
    vi.stubEnv('QUORUM_OPERATOR_HOSTNAME', 'start.quorum.example.org');
    vi.stubEnv('QUORUM_PUBLIC_URL', '');
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
      logger: true,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    });
    apps.push(app);

    expect(lines.join('')).toContain('QUORUM_OPERATOR_HOSTNAME');
  });

  it('stays quiet once the public URL is set', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-operator-quiet-'));
    const lines: string[] = [];
    vi.stubEnv('QUORUM_ROOM_CREATION', 'operator');
    vi.stubEnv('QUORUM_OPERATOR_HOSTNAME', 'start.quorum.example.org');
    vi.stubEnv('QUORUM_PUBLIC_URL', 'https://quorum.example.org');
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
      logger: true,
      logDestination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    });
    apps.push(app);

    expect(lines.join('')).not.toContain('QUORUM_OPERATOR_HOSTNAME');
  });
});

describe('host claim', () => {
  async function freshApp() {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const app = await buildApp({ databasePath: join(directory, 'quorum.db') });
    apps.push(app);
    return app;
  }

  async function createRoom(app: Awaited<ReturnType<typeof buildApp>>) {
    return (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { [REQUEST_HEADER]: '1' },
      })
    ).json<CreateRoomResponse>();
  }

  it('gives the first device to open the host screen a host session', async () => {
    const app = await freshApp();
    const created = await createRoom(app);

    const opened = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
    });

    expect(opened.statusCode).toBe(200);
    const claim = opened.cookies.find(
      (cookie) => cookie.name === `quorum_host_${created.roomId}`,
    );
    expect(claim?.value).toBeTruthy();
    expect(claim?.httpOnly).toBe(true);

    // The claim alone drives host controls, so a link truncated on the way to
    // a phone does not cost the host their room.
    const started = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.roomId}/start`,
      headers: { [REQUEST_HEADER]: '1' },
      cookies: { [`quorum_host_${created.roomId}`]: claim?.value ?? '' },
    });
    // 409, not 404: the claim authenticated the host, and the room simply has
    // nobody in it yet.
    expect(started.statusCode).toBe(409);
    expect(started.json<ErrorResponse>().error).toBe('conflict');
  });

  it('reissues the claim to a later device holding the capability', async () => {
    const app = await freshApp();
    const created = await createRoom(app);

    const first = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
    });
    const firstClaim =
      first.cookies.find(
        (cookie) => cookie.name === `quorum_host_${created.roomId}`,
      )?.value ?? '';

    const second = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
    });
    const secondClaim =
      second.cookies.find(
        (cookie) => cookie.name === `quorum_host_${created.roomId}`,
      )?.value ?? '';

    expect(secondClaim).not.toBe('');
    expect(secondClaim).not.toBe(firstClaim);

    // The takeover retires the earlier device's session; the capability it
    // came from still works, which is what makes this a move rather than a
    // lockout.
    const stale = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.roomId}`,
      cookies: { [`quorum_host_${created.roomId}`]: firstClaim },
    });
    expect(stale.statusCode).toBe(404);
  });

  it('claims the room back for a device whose session was superseded', async () => {
    const app = await freshApp();
    const created = await createRoom(app);

    const first = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
    });
    const firstClaim =
      first.cookies.find(
        (cookie) => cookie.name === `quorum_host_${created.roomId}`,
      )?.value ?? '';
    await app.inject({ method: 'GET', url: `/api/host/${created.hostToken}` });

    // The first device reloads with a cookie another device has retired. It
    // still holds the capability, so it takes the room back instead of seeing
    // the not-found that a bad capability earns.
    const reload = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
      cookies: { [`quorum_host_${created.roomId}`]: firstClaim },
    });
    expect(reload.statusCode).toBe(200);
    expect(
      reload.cookies.find(
        (cookie) => cookie.name === `quorum_host_${created.roomId}`,
      )?.value,
    ).not.toBe(firstClaim);
  });

  it('shows the host the invite phrase without the creating browser', async () => {
    const app = await freshApp();
    const created = await createRoom(app);

    // A room minted in a shell leaves nothing in any browser, so the host view
    // is the only place the invite can come back from.
    const view = await app.inject({
      method: 'GET',
      url: `/api/host/${created.hostToken}`,
    });
    expect(view.json<{ invite: string | null }>().invite).toBe(
      created.inviteToken,
    );

    // Nobody else sees it: the invite is the credential that admits people.
    const joined = await app.inject({
      method: 'POST',
      url: `/api/invites/${created.inviteToken}/join`,
      headers: { [REQUEST_HEADER]: '1' },
      payload: { displayName: 'Ada' },
    });
    const session =
      joined.cookies.find((cookie) => cookie.name.startsWith('quorum_session_'))
        ?.value ?? '';
    const guest = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.roomId}`,
      cookies: { [`quorum_session_${created.roomId}`]: session },
    });
    expect(guest.json<{ invite: string | null }>().invite).toBeNull();
  });
});
