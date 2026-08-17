import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  sessionCookieName,
  type CatalogSource,
  type CreateRoomResponse,
  type ResultsResponse,
  type RoomView,
} from '@quorum/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { RateLimiter } from '../rate-limit.js';

/**
 * These tests assert room rules, not abuse rules, and they create far more
 * rooms from one address than any human would. Rate limiting has its own
 * suite in `rate-limit.test.ts` and `routes.rate-limit.test.ts`.
 */
const unlimited = (): RateLimiter => new RateLimiter({ scale: 0 });

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createApp(now?: () => Date): Promise<FastifyInstance> {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-rooms-'));
  const app = await buildApp({
    databasePath: join(directory, 'quorum.db'),
    staticDirectory: join(directory, 'missing'),
    rateLimiter: unlimited(),
    ...(now === undefined ? {} : { now }),
  });
  apps.push(app);
  return app;
}

const mutationHeaders = { [REQUEST_HEADER]: '1' };

interface Participant {
  roomId: string;
  participantId: string;
  cookie: string;
}

async function createRoom(app: FastifyInstance): Promise<CreateRoomResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: mutationHeaders,
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function joinRoom(
  app: FastifyInstance,
  room: CreateRoomResponse,
  displayName: string,
  asHost = false,
): Promise<Participant> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/invites/${room.inviteToken}/join`,
    headers: asHost
      ? { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken }
      : mutationHeaders,
    payload: { displayName },
  });
  expect(response.statusCode).toBe(201);
  const cookie = response.cookies.find(
    (candidate) => candidate.name === sessionCookieName(room.roomId),
  );
  expect(cookie).toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  return {
    roomId: room.roomId,
    participantId: response.json<{ participantId: string }>().participantId,
    cookie: `${cookie?.name ?? ''}=${cookie?.value ?? ''}`,
  };
}

async function start(
  app: FastifyInstance,
  room: CreateRoomResponse,
): Promise<RoomView> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/rooms/${room.roomId}/start`,
    headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
  });
  expect(response.statusCode).toBe(200);
  return response.json<RoomView>();
}

async function view(
  app: FastifyInstance,
  participant: Participant,
): Promise<RoomView> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/rooms/${participant.roomId}`,
    headers: { cookie: participant.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<RoomView>();
}

async function swipe(
  app: FastifyInstance,
  participant: Participant,
  exposureId: string,
  choice: 'LEFT' | 'RIGHT',
): Promise<{ statusCode: number; room?: RoomView }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/rooms/${participant.roomId}/swipe`,
    headers: { ...mutationHeaders, cookie: participant.cookie },
    payload: { exposureId, choice },
  });
  if (response.statusCode !== 200) return { statusCode: response.statusCode };
  return {
    statusCode: response.statusCode,
    room: response.json<{ room: RoomView }>().room,
  };
}

/** Swipe through the whole slate, choosing RIGHT for the given positions. */
async function voteAll(
  app: FastifyInstance,
  participant: Participant,
  rightPositions: (position: number) => boolean,
): Promise<RoomView> {
  let current = await view(app, participant);
  while (current.card !== null) {
    const choice = rightPositions(current.card.slatePosition)
      ? 'RIGHT'
      : 'LEFT';
    const result = await swipe(
      app,
      participant,
      current.card.exposureId,
      choice,
    );
    expect(result.statusCode).toBe(200);
    if (result.room === undefined) throw new Error('missing room view');
    current = result.room;
  }
  return current;
}

async function results(
  app: FastifyInstance,
  participant: Participant,
): Promise<ResultsResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/rooms/${participant.roomId}/results`,
    headers: { cookie: participant.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ResultsResponse>();
}

describe('catalog source', () => {
  it('describes the installed catalog without claiming the wrong provider', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/catalog' });
    expect(response.statusCode).toBe(200);
    const body = response.json<CatalogSource>();
    expect(body.provider).toBe('synthetic');
    expect(body.itemCount).toBeGreaterThanOrEqual(20);
    // A fixture build must not display the TMDB notice.
    expect(body.attribution).toBeNull();
  });
});

describe('room lifecycle', () => {
  it('issues separate unguessable invite and host capabilities', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    expect(room.inviteToken).not.toBe(room.hostToken);
    for (const token of [room.inviteToken, room.hostToken]) {
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(16);
    }
    expect(room.state).toBe('LOBBY');
  });

  it('runs two participants through a full room and ranks the result', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const host = await joinRoom(app, room, 'Host', true);
    const guest = await joinRoom(app, room, 'Guest');

    const lobby = await view(app, host);
    expect(lobby.participants).toHaveLength(2);
    expect(lobby.card).toBeNull();

    const started = await start(app, room);
    expect(started.state).toBe('VOTING');
    expect(started.slateSize).toBe(20);
    expect(started.eligibleCount).toBe(2);

    // Both say yes to position 1; only the host says yes to position 2.
    const hostFinal = await voteAll(app, host, (position) => position <= 2);
    expect(hostFinal.you?.complete).toBe(true);
    expect(hostFinal.state).toBe('VOTING');

    const guestFinal = await voteAll(app, guest, (position) => position === 1);
    expect(guestFinal.state).toBe('COMPLETE');
    expect(guestFinal.resultsAvailable).toBe(true);

    const ranked = await results(app, guest);
    expect(ranked.items).toHaveLength(20);
    expect(ranked.closedEarly).toBe(false);
    const [first, second] = ranked.items;
    expect(first?.rank).toBe(1);
    expect(first?.approvalPct).toBe(100);
    expect(first?.yesFraction).toBe('2/2');
    expect(first?.match).toBe(true);
    expect(second?.approvalPct).toBe(50);
    expect(second?.match).toBe(false);
    expect(ranked.items.filter((item) => item.approvalPct === 0)).toHaveLength(
      18,
    );
    for (const item of ranked.items) expect(item.coveragePct).toBe(100);

    // Both participants see the same canonical ranking.
    expect(await results(app, host)).toEqual(ranked);
  });

  it('produces a solo shortlist with right swipes first', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const solo = await joinRoom(app, room, 'Solo', true);
    await start(app, room);
    const final = await voteAll(app, solo, (position) => position % 2 === 1);
    expect(final.state).toBe('COMPLETE');

    const ranked = await results(app, solo);
    expect(ranked.items.slice(0, 10).every((item) => item.match)).toBe(true);
    expect(ranked.items.slice(10).every((item) => item.approvalPct === 0)).toBe(
      true,
    );
    expect(ranked.items[0]?.yesFraction).toBe('1/1');
  });

  it('keeps non-responses in the denominator after an early close', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const host = await joinRoom(app, room, 'Host', true);
    await joinRoom(app, room, 'Second');
    await joinRoom(app, room, 'Third');
    await joinRoom(app, room, 'Fourth');
    await start(app, room);

    const first = await view(app, host);
    expect(first.card).not.toBeNull();
    await swipe(app, host, first.card?.exposureId ?? '', 'RIGHT');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/close`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<RoomView>().state).toBe('COMPLETE');

    const ranked = await results(app, host);
    expect(ranked.closedEarly).toBe(true);
    expect(ranked.eligibleCount).toBe(4);
    const top = ranked.items[0];
    expect(top?.approvalPct).toBe(25);
    expect(top?.coveragePct).toBe(25);
    expect(top?.match).toBe(false);
  });

  it('hides results until voting ends', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const host = await joinRoom(app, room, 'Host', true);
    await joinRoom(app, room, 'Guest');
    await start(app, room);

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.roomId}/results`,
      headers: { cookie: host.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('conflict');
  });

  it('confirms a retried swipe idempotently and rejects a changed choice', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const solo = await joinRoom(app, room, 'Solo', true);
    await start(app, room);
    const card = (await view(app, solo)).card;
    const exposureId = card?.exposureId ?? '';

    const first = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/swipe`,
      headers: { ...mutationHeaders, cookie: solo.cookie },
      payload: { exposureId, choice: 'RIGHT' },
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/swipe`,
      headers: { ...mutationHeaders, cookie: solo.cookie },
      payload: { exposureId, choice: 'RIGHT' },
    });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ confirmedAt: string }>().confirmedAt).toBe(
      first.json<{ confirmedAt: string }>().confirmedAt,
    );

    const flipped = await swipe(app, solo, exposureId, 'LEFT');
    expect(flipped.statusCode).toBe(409);
    expect((await view(app, solo)).you?.confirmedCount).toBe(1);
  });

  it('resumes at the first unconfirmed card after a reconnect', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const solo = await joinRoom(app, room, 'Solo', true);
    await start(app, room);

    for (let index = 0; index < 7; index += 1) {
      const card = (await view(app, solo)).card;
      await swipe(app, solo, card?.exposureId ?? '', 'RIGHT');
    }
    const reconnect = await view(app, solo);
    expect(reconnect.card?.slatePosition).toBe(8);
    expect(reconnect.you?.confirmedCount).toBe(7);
    expect(reconnect.resultsAvailable).toBe(false);

    // A second reconnect returns the same exposure identity.
    expect((await view(app, solo)).card?.exposureId).toBe(
      reconnect.card?.exposureId,
    );
  });
});

describe('authorization', () => {
  it('answers unknown, modified, and expired capabilities identically', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const modified = `${room.inviteToken.slice(0, -1)}${
      room.inviteToken.endsWith('a') ? 'b' : 'a'
    }`;

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/invites/${'z'.repeat(43)}`,
    });
    const tampered = await app.inject({
      method: 'GET',
      url: `/api/invites/${modified}`,
    });
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/expire`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
    });
    const expired = await app.inject({
      method: 'GET',
      url: `/api/invites/${room.inviteToken}`,
    });

    for (const response of [unknown, tampered, expired]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'not_found',
        message: 'Not found',
      });
    }
  });

  it('expires a room once its retention window passes', async () => {
    let current = new Date('2026-08-14T00:00:00.000Z');
    const app = await createApp(() => current);
    const room = await createRoom(app);
    const host = await joinRoom(app, room, 'Host', true);
    current = new Date('2026-08-16T00:00:00.000Z');

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${room.roomId}`,
      headers: { cookie: host.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects cross-room and cross-participant access', async () => {
    const app = await createApp();
    const roomA = await createRoom(app);
    const roomB = await createRoom(app);
    const participantA = await joinRoom(app, roomA, 'A', true);
    await joinRoom(app, roomB, 'B', true);

    const crossRoom = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomB.roomId}`,
      headers: { cookie: participantA.cookie },
    });
    expect(crossRoom.statusCode).toBe(404);

    const crossHost = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomB.roomId}/start`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: roomA.hostToken },
    });
    expect(crossHost.statusCode).toBe(404);
  });

  it('never lets a participant perform host actions', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const guest = await joinRoom(app, room, 'Guest');

    for (const action of ['start', 'close', 'expire']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/rooms/${room.roomId}/${action}`,
        headers: { ...mutationHeaders, cookie: guest.cookie },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('refuses another participant exposure and requires a session', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const host = await joinRoom(app, room, 'Host', true);
    const guest = await joinRoom(app, room, 'Guest');
    await start(app, room);
    const guestCard = (await view(app, guest)).card;

    const stolen = await swipe(app, host, guestCard?.exposureId ?? '', 'RIGHT');
    expect(stolen.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/swipe`,
      headers: mutationHeaders,
      payload: { exposureId: guestCard?.exposureId, choice: 'RIGHT' },
    });
    expect(anonymous.statusCode).toBe(404);
  });

  it('rejects mutations without the same-origin request header', async () => {
    const app = await createApp();
    const missingHeader = await app.inject({
      method: 'POST',
      url: '/api/rooms',
    });
    expect(missingHeader.statusCode).toBe(400);

    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: {
        ...mutationHeaders,
        origin: 'https://evil.example',
        host: 'quorum.example',
      },
    });
    expect(crossOrigin.statusCode).toBe(400);
  });

  it('rejects joins after voting starts and enforces the display-name rules', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    await joinRoom(app, room, 'Host', true);

    const empty = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: mutationHeaders,
      payload: { displayName: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const controlCharacter = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: mutationHeaders,
      payload: { displayName: 'evil‮name' },
    });
    expect(controlCharacter.statusCode).toBe(400);

    await start(app, room);
    const late = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: mutationHeaders,
      payload: { displayName: 'Latecomer' },
    });
    expect(late.statusCode).toBe(409);
  });

  it('caps participants per room', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    for (let index = 0; index < 20; index += 1) {
      await joinRoom(app, room, `Player ${index.toString()}`);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: `/api/invites/${room.inviteToken}/join`,
      headers: mutationHeaders,
      payload: { displayName: 'One too many' },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json<{ error: string }>().error).toBe(
      'too_many_participants',
    );
  });

  it('refuses to start an empty room or start twice', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const empty = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/start`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
    });
    expect(empty.statusCode).toBe(409);

    await joinRoom(app, room, 'Host', true);
    await start(app, room);
    const again = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomId}/start`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
    });
    expect(again.statusCode).toBe(409);
  });

  it('lets the host join with the host capability, then start and vote', async () => {
    const app = await createApp();
    const room = await createRoom(app);

    const joined = await app.inject({
      method: 'POST',
      url: `/api/host/${room.hostToken}/join`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
      payload: { displayName: 'Host' },
    });
    expect(joined.statusCode).toBe(201);
    const cookie = joined.cookies.find(
      (candidate) => candidate.name === sessionCookieName(room.roomId),
    );
    expect(cookie).toBeDefined();
    const host: Participant = {
      roomId: room.roomId,
      participantId: joined.json<{ participantId: string }>().participantId,
      cookie: `${cookie?.name ?? ''}=${cookie?.value ?? ''}`,
    };
    expect(joined.json<{ room: RoomView }>().room.you?.isHost).toBe(true);

    await start(app, room);

    // The host view carries the host's own card once they are also a player.
    const hostView = await app.inject({
      method: 'GET',
      url: `/api/host/${room.hostToken}`,
      headers: { cookie: host.cookie },
    });
    expect(hostView.statusCode).toBe(200);
    const asHost = hostView.json<RoomView>();
    expect(asHost.isHost).toBe(true);
    expect(asHost.you?.participantId).toBe(host.participantId);
    expect(asHost.card).not.toBeNull();

    const swiped = await swipe(
      app,
      host,
      asHost.card?.exposureId ?? '',
      'RIGHT',
    );
    expect(swiped.statusCode).toBe(200);
    expect(swiped.room?.you?.confirmedCount).toBe(1);
  });

  it('refuses a second host join and rejects host joins without the capability', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const hostJoin = {
      method: 'POST' as const,
      url: `/api/host/${room.hostToken}/join`,
      headers: { ...mutationHeaders, [HOST_TOKEN_HEADER]: room.hostToken },
      payload: { displayName: 'Host' },
    };
    expect((await app.inject(hostJoin)).statusCode).toBe(201);
    expect((await app.inject(hostJoin)).statusCode).toBe(409);

    const wrongCapability = await app.inject({
      method: 'POST',
      url: `/api/host/${room.inviteToken}/join`,
      headers: mutationHeaders,
      payload: { displayName: 'Impostor' },
    });
    expect(wrongCapability.statusCode).toBe(404);
  });

  it('leaves the host view usable before the host joins as a player', async () => {
    const app = await createApp();
    const room = await createRoom(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/host/${room.hostToken}`,
    });
    expect(response.statusCode).toBe(200);
    const asHost = response.json<RoomView>();
    expect(asHost.isHost).toBe(true);
    expect(asHost.you).toBeNull();
    expect(asHost.card).toBeNull();
  });
});

describe('durability', () => {
  it('keeps confirmed votes and room state across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-restart-'));
    const databasePath = join(directory, 'quorum.db');
    const staticDirectory = join(directory, 'missing');
    const first = await buildApp({
      databasePath,
      staticDirectory,
      rateLimiter: unlimited(),
    });
    apps.push(first);

    const room = await createRoom(first);
    const solo = await joinRoom(first, room, 'Solo', true);
    await start(first, room);
    const card = (await view(first, solo)).card;
    await swipe(first, solo, card?.exposureId ?? '', 'RIGHT');
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await buildApp({
      databasePath,
      staticDirectory,
      rateLimiter: unlimited(),
    });
    apps.push(second);
    const resumed = await view(second, solo);
    expect(resumed.state).toBe('VOTING');
    expect(resumed.you?.confirmedCount).toBe(1);
    expect(resumed.card?.slatePosition).toBe(2);
  });
});
