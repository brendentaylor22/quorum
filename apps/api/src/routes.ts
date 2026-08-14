import {
  HOST_TOKEN_HEADER,
  REQUEST_HEADER,
  capabilityTokenSchema,
  createRoomResponseSchema,
  joinRequestSchema,
  publicIdSchema,
  sessionCookieName,
  swipeRequestSchema,
  type CreateRoomResponse,
  type ErrorResponse,
} from '@quorum/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { secureCookies } from './capabilities.js';
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

function parsePathToken(value: unknown): string {
  const parsed = capabilityTokenSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
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

export function registerRoomRoutes(
  app: FastifyInstance,
  service: RoomService,
): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.url.startsWith('/api/')) service.expireDueRooms();
    done();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      const body: ErrorResponse = { error: error.code, message: error.message };
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

  app.post('/api/rooms', (request, reply) => {
    requireSameOrigin(request);
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

  app.get('/api/host/:hostToken', (request) => {
    const { hostToken: token } = request.params as { hostToken: string };
    const capability = parsePathToken(token);
    const room = service.roomByHostCapability(capability);
    // Resolve the session too, so a host who is also playing sees their card.
    const { room: resolved, caller } = service.resolveCaller(
      room.publicId,
      sessionToken(request, room.publicId),
      capability,
    );
    return service.view(resolved, caller);
  });

  app.post('/api/host/:hostToken/join', (request, reply) => {
    requireSameOrigin(request);
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
    );
    return reply.code(201).send({
      participantId: joined.participantId,
      room: service.view(room, caller),
    });
  });

  app.get('/api/rooms/:roomId', (request) => {
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    const { room, caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/start', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    const room = service.start(roomId, hostToken(request));
    const { caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/close', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    const room = service.close(roomId, hostToken(request));
    const { caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
    );
    return service.view(room, caller);
  });

  app.post('/api/rooms/:roomId/expire', (request, reply) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    service.expire(roomId, hostToken(request));
    return reply.code(204).send();
  });

  app.post('/api/rooms/:roomId/swipe', (request) => {
    requireSameOrigin(request);
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    const parsed = swipeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Invalid swipe');
    }
    const { room, caller } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
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
    );
    return {
      exposureId: parsed.data.exposureId,
      choice: parsed.data.choice,
      confirmedAt: confirmation.confirmedAt,
      room: service.view(refreshed.room, refreshed.caller),
    };
  });

  app.get('/api/rooms/:roomId/results', (request) => {
    const roomId = parseRoomId((request.params as { roomId: string }).roomId);
    const { room } = service.resolveCaller(
      roomId,
      sessionToken(request, roomId),
      hostToken(request),
    );
    return service.results(room);
  });
}
