import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  capabilityTokenSchema,
  hostCookieName,
  createRoomResponseSchema,
  joinRequestSchema,
  publicIdSchema,
  sessionCookieName,
  swipeRequestSchema,
  type CreateRoomResponse,
  type ErrorResponse,
} from '@quorum/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { secureCookies } from './capabilities.js';
import { instanceInfo, roomCreationMode } from './instance.js';
import { POLICIES, RateLimiter, type RateLimitPolicy } from './rate-limit.js';
import { ApiError, notFound, RoomService } from './rooms/service.js';

const SESSION_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

function hostToken(request: FastifyRequest): string | undefined {
  const raw = request.headers[HOST_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  return capabilityTokenSchema.safeParse(value).success ? value : undefined;
}

function sessionToken(
  request: FastifyRequest,
  roomId: string,
): string | undefined {
  const value = request.cookies[sessionCookieName(roomId)];
  if (value === undefined) return undefined;
  return capabilityTokenSchema.safeParse(value).success ? value : undefined;
}

/**
 * The host session this device holds for a room, if it has claimed one. It
 * stands in for the host capability so host controls survive a link that never
 * made it intact into a chat app.
 */
function hostClaim(
  request: FastifyRequest,
  roomId: string,
): string | undefined {
  const value = request.cookies[hostCookieName(roomId)];
  if (value === undefined) return undefined;
  return capabilityTokenSchema.safeParse(value).success ? value : undefined;
}

function requireSameOrigin(request: FastifyRequest): void {
  if (request.headers[REQUEST_HEADER] !== '1') {
    throw new ApiError(400, 'invalid_request', 'Missing request header');
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(400, 'invalid_request', 'Invalid origin');
  }
  if (originHost !== request.headers.host) {
    throw new ApiError(400, 'invalid_request', 'Cross-origin request rejected');
  }
}

/**
 * An opaque, stable bucket id for a secret. Truncated because this only has to
 * separate honest callers from each other, never to authenticate anyone.
 */
function bucketId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * Rate-limit scope for a host mutation. Either credential identifies the same
 * host, so a device acting through its host session shares one bucket with the
 * capability rather than getting a second allowance.
 */
function hostBucket(request: FastifyRequest, roomId: string): string {
  const token = hostToken(request) ?? hostClaim(request, roomId);
  return `h:${bucketId(token ?? '')}`;
}

function parsePathToken(value: unknown): string {
  const parsed = capabilityTokenSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** Optional `?round=N` selector; absent means the latest completed round. */
function parseRound(request: FastifyRequest): number | undefined {
  const raw = (request.query as { round?: unknown }).round;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(400, 'invalid_request', 'Invalid round');
  }
  return parsed;
}

function parseRoomId(value: unknown): string {
  const parsed = publicIdSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function setSessionCookie(
  reply: FastifyReply,
  roomId: string,
  token: string,
): void {
  reply.setCookie(sessionCookieName(roomId), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

function setHostCookie(
  reply: FastifyReply,
  roomId: string,
  token: string,
): void {
  reply.setCookie(hostCookieName(roomId), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export interface RoomRouteOptions {
  /** Injectable so tests can drive windows without waiting for wall clock. */
  rateLimiter?: RateLimiter;
}

export function registerRoomRoutes(
  app: FastifyInstance,
  service: RoomService,
  options: RoomRouteOptions = {},
): void {
  const limiter = options.rateLimiter ?? new RateLimiter();

  /**
   * Spend one slot of a policy for this caller, or refuse.
   *
   * The key is the client source plus whatever scope the operation has. Source
   * alone would let one abusive network exhaust a shared quota for a whole
   * room; scope alone would let one attacker exhaust a room's quota for its
   * honest participants. `request.ip` honours `trustProxy`, which an operator
   * must configure when Quorum sits behind a proxy — otherwise every caller
   * shares the proxy's address, and therefore one bucket. That is documented
   * as an operator obligation rather than guessed at here, because believing
   * an untrusted `X-Forwarded-For` would make the limit trivially evadable.
   */
  function spend(
    request: FastifyRequest,
    policy: RateLimitPolicy,
    scope?: string,
  ): void {
    const key = scope === undefined ? request.ip : `${request.ip}|${scope}`;
    const decision = limiter.check(key, policy);
    if (decision.allowed) return;
    throw new ApiError(
      429,
      'rate_limited',
      'Too many requests',
      decision.retryAfterSeconds,
    );
  }

  /**
   * Reads inside a room are charged to the session, not the address. Four
   * phones on one wifi polling the same room are four honest callers, and
   * keying on the address alone would have them starve each other. A session is
   * not free to mint — joining is itself limited — so it is the right unit.
   *
   * The session token is a secret, so it is hashed into an opaque bucket id
   * that never reaches a log, a header, or an error.
   */
  function roomReadScope(request: FastifyRequest, roomId: string): string {
    const session = sessionToken(request, roomId);
    if (session !== undefined) return `s:${bucketId(session)}`;
    const host = hostToken(request);
    if (host !== undefined) return `h:${bucketId(host)}`;
    return `r:${roomId}`;
  }

  app.addHook('onRequest', (request, _reply, done) => {
    if (request.url.startsWith('/api/')) service.expireDueRooms();
    done();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      const body: ErrorResponse = { error: error.code, message: error.message };
      if (error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', error.retryAfterSeconds.toString());
      }
      return reply.code(error.status).send(body);
    }
    const statusCode =
      error !== null && typeof error === 'object' && 'statusCode' in error
        ? (error as { statusCode?: number }).statusCode
        : undefined;
    if (statusCode !== undefined && statusCode < 500) {
      const body: ErrorResponse = {
        error: 'invalid_request',
        message: 'Invalid request',
      };
      return reply.code(statusCode).send(body);
    }
    request.log.error(error);
    const body: ErrorResponse = {
      error: 'invalid_request',
      message: 'Unexpected error',
    };
    return reply.code(500).send(body);
  });

  /**
   * Where movie metadata came from, including the notice the provider requires
   * be displayed. Public and unauthenticated: it describes the catalog, not any
   * room, and carries nothing room-scoped.
   */
  app.get('/api/catalog', () => service.catalogSource());

  /**
   * What this instance is: its licence and where its source lives. Public and
   * unauthenticated, because the AGPL's offer of source is owed to anyone
   * interacting with it, including someone who never joins a room.
   */
  app.get('/api/instance', () => instanceInfo());

  app.post('/api/rooms', (request, reply) => {
    requireSameOrigin(request);
    // Checked before the rate limiter spends a slot: on a closed instance this
    // endpoint is not a scarce resource being protected, it is not a resource
    // at all, and a bot hammering it should not be able to exhaust the bucket
    // that the operator's own CLI-minted rooms are unaffected by anyway.
    if (roomCreationMode() === 'operator') {
      throw new ApiError(
        403,
        'room_creation_disabled',
        'This instance creates rooms by invitation only',
      );
    }
    spend(request, POLICIES.createRoom);
    const created = service.createRoom();
    const body: CreateRoomResponse = createRoomResponseSchema.parse({
      roomId: created.roomId,
      inviteToken: created.inviteToken,
      hostToken: created.hostToken,
      invitePath: `/join/${created.inviteToken}`,
      hostPath: `/host/${created.hostToken}`,
      state: 'LOBBY',
      expiresAt: created.expiresAt,
    });
    return reply.code(201).send(body);
  });

  app.get('/api/invites/:inviteToken', (request) => {
    spend(request, POLICIES.capabilityRead);
    const { inviteToken } = request.params as { inviteToken: string };
    const room = service.roomByInvite(parsePathToken(inviteToken));
    const caller = { participant: undefined, isHost: false };
    const view = service.view(room, caller);
    return {
      roomId: view.roomId,
      state: view.state,
      participants: view.participants.map((participant) => ({
        participantId: participant.participantId,
        displayName: participant.displayName,
        isHost: participant.isHost,
        confirmedCount: 0,
        complete: false,
      })),
    };
  });

  app.post('/api/invites/:inviteToken/join', (request, reply) => {
    requireSameOrigin(request);
    spend(request, POLICIES.join);
    const { inviteToken } = request.params as { inviteToken: string };
    const token = parsePathToken(inviteToken);
    const parsed = joinRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Invalid display name');
    }
    const joined = service.join(
      token,
      parsed.data.displayName,
      hostToken(request) !== undefined,
    );
    setSessionCookie(reply, joined.roomId, joined.sessionToken);
    const { room, caller } = service.resolveCaller(
      joined.roomId,
      joined.sessionToken,
      hostToken(request),
    );
    return reply.code(201).send({
      participantId: joined.participantId,
      room: service.view(room, caller),
    });
  });

  /**
   * Open the host screen. Whoever gets here first claims the room: the reply
   * carries a host session for this device, which is what makes a link minted
   * in a shell on the server usable from a phone. A later device presenting
   * the capability claims it in turn.
   */
  app.get('/api/host/:hostToken', (request, reply) => {
    spend(request, POLICIES.capabilityRead);
    const { hostToken: token } = request.params as { hostToken: string };
    const capability = parsePathToken(token);
    const room = service.roomByHostCapability(capability);
    let claim = hostClaim(request, room.publicId);
    // A superseded cookie is not an error: this device holds the capability, so
    // it claims the room back rather than being turned away.
    if (claim === undefined || !service.holdsHostClaim(room.publicId, claim)) {
      const claimed = service.claimHost(capability);
      claim = claimed.claimToken;
      setHostCookie(reply, room.publicId, claim);
    }
    // Resolve the session too, so a host who is also playing sees their card.
    const { room: resolved, caller } = service.resolveCaller(
      room.publicId,
      sessionToken(request, room.publicId),
      capability,
      claim,
    );
    return service.view(resolved, caller);
  });

  app.post('/api/host/:hostToken/join', (request, reply) => {
    requireSameOrigin(request);
    spend(request, POLICIES.join);
    const { hostToken: token } = request.params as { hostToken: string };
    const capability = parsePathToken(token);
    const parsed = joinRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Invalid display name');
    }
    const joined = service.joinAsHost(capability, parsed.data.displayName);
    setSessionCookie(reply, joined.roomId, joined.sessionToken);
    const { room, caller } = service.resolveCaller(
      joined.roomId,
      joined.sessionToken,
      capability,
      hostClaim(request, joined.roomId),
    );
    return reply.code(201).send({
      participantId: joined.participantId,
      room: service.view(room, caller),
    });
  });

  app.get('/api/rooms/:roomId', (request) => {
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.read, roomReadScope(request, roomId));
    const { room, caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/start', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.hostMutation, hostBucket(request, roomId));
    const room = service.start(
      roomId,
      hostToken(request),
      hostClaim(request, roomId),
    );
    const { caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/close', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.hostMutation, hostBucket(request, roomId));
    const room = service.close(
      roomId,
      hostToken(request),
      hostClaim(request, roomId),
    );
    const { caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/expire', (request, reply) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.hostMutation, hostBucket(request, roomId));
    service.expire(roomId, hostToken(request), hostClaim(request, roomId));
    return reply.code(204).send();
  });

  app.post('/api/rooms/:roomId/swipe', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.swipe, roomReadScope(request, roomId));
    const parsed = swipeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Invalid swipe');
    }
    const { room, caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    if (caller.participant === undefined) throw notFound();
    const confirmation = service.swipe(
      room,
      caller.participant,
      parsed.data.exposureId,
      parsed.data.choice,
    );
    const refreshed = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return {
      exposureId: parsed.data.exposureId,
      choice: parsed.data.choice,
      confirmedAt: confirmation.confirmedAt,
      room: service.view(refreshed.room, refreshed.caller),
    };
  });

  /** Open another round from what the group has already voted on. */
  app.post('/api/rooms/:roomId/continue', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.hostMutation, hostBucket(request, roomId));
    const room = service.continueVoting(
      roomId,
      hostToken(request),
      hostClaim(request, roomId),
    );
    const { caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return service.view(room, caller);
  });

  app.get('/api/rooms/:roomId/results', (request) => {
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    spend(request, POLICIES.read, roomReadScope(request, roomId));
    const { room } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
      hostClaim(request, roomId),
    );
    return service.results(room, parseRound(request));
  });
}
