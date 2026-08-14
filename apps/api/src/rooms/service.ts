import { loadFixtureCatalog, selectSlate } from '@quorum/catalog';
import {
  MAX_PARTICIPANTS_PER_ROOM,
  SLATE_SIZE,
  type CatalogItemDto,
  type Choice,
  type ErrorCode,
  type ParticipantSummary,
  type ResultsResponse,
  type RoomView,
} from '@quorum/contracts';
import type { QuorumDatabase } from '@quorum/database';
import { rankSlate } from '@quorum/ranking';
import {
  hashCapability,
  issueCapability,
  issuePublicId,
} from '../capabilities.js';
import * as repository from './repository.js';
import type { ParticipantRow, RoomRow, SlateItemRow } from './repository.js';

const HOUR_MS = 60 * 60 * 1000;
const LOBBY_LIFETIME_MS = 24 * HOUR_MS;
const VOTING_LIFETIME_MS = 24 * HOUR_MS;
const COMPLETED_LIFETIME_MS = 7 * 24 * HOUR_MS;

/**
 * Every capability failure — unknown, modified, expired, or belonging to
 * another room — answers `not_found` so room existence never leaks.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'Not found');
}

export function conflict(message: string): ApiError {
  return new ApiError(409, 'conflict', message);
}

export interface RoomServiceOptions {
  database: QuorumDatabase;
  secret: Buffer;
  now?: () => Date;
}

export interface Caller {
  participant?: ParticipantRow | undefined;
  isHost: boolean;
}

export interface CreatedRoom {
  roomId: string;
  inviteToken: string;
  hostToken: string;
  expiresAt: string;
}

export interface JoinedRoom {
  participantId: string;
  sessionToken: string;
  roomId: string;
}

export class RoomService {
  private readonly database: QuorumDatabase;
  private readonly secret: Buffer;
  private readonly clock: () => Date;

  constructor(options: RoomServiceOptions) {
    this.database = options.database;
    this.secret = options.secret;
    this.clock = options.now ?? (() => new Date());
  }

  /** Load the fixture catalog snapshot. Phase 4 replaces the source only. */
  importFixtureCatalog(): number {
    return repository.importCatalog(
      this.database,
      loadFixtureCatalog(),
      this.nowIso(),
    );
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private later(milliseconds: number): string {
    return new Date(this.clock().getTime() + milliseconds).toISOString();
  }

  /** Expire rooms past their retention window before any capability check. */
  expireDueRooms(): number {
    const due = repository.listExpiredRoomIds(this.database, this.nowIso());
    for (const roomId of due) {
      repository.markRoomExpired(this.database, roomId);
      repository.recordAudit(
        this.database,
        roomId,
        'room.expired',
        null,
        this.nowIso(),
      );
    }
    return due.length;
  }

  createRoom(): CreatedRoom {
    const inviteToken = issueCapability();
    const hostToken = issueCapability();
    const room = repository.insertRoom(this.database, {
      publicId: issuePublicId(),
      inviteTokenHash: hashCapability(this.secret, inviteToken),
      hostTokenHash: hashCapability(this.secret, hostToken),
      createdAt: this.nowIso(),
      expiresAt: this.later(LOBBY_LIFETIME_MS),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'room.created',
      null,
      this.nowIso(),
    );
    return {
      roomId: room.publicId,
      inviteToken,
      hostToken,
      expiresAt: room.expiresAt,
    };
  }

  private liveRoom(room: RoomRow | undefined): RoomRow {
    if (room === undefined) throw notFound();
    if (room.state === 'EXPIRED') throw notFound();
    if (Date.parse(room.expiresAt) <= this.clock().getTime()) {
      repository.markRoomExpired(this.database, room.id);
      throw notFound();
    }
    return room;
  }

  roomByInvite(inviteToken: string): RoomRow {
    return this.liveRoom(
      repository.findRoomByInviteHash(
        this.database,
        hashCapability(this.secret, inviteToken),
      ),
    );
  }

  roomByHostCapability(hostToken: string): RoomRow {
    return this.liveRoom(
      repository.findRoomByHostHash(
        this.database,
        hashCapability(this.secret, hostToken),
      ),
    );
  }

  /**
   * Resolve the caller for a room. A session cookie authorises only its own
   * participant in its own room; the host capability authorises host actions
   * only for the room it was issued for.
   */
  resolveCaller(
    roomPublicId: string,
    sessionToken: string | undefined,
    hostToken: string | undefined,
  ): { room: RoomRow; caller: Caller } {
    const room = this.liveRoom(
      repository.findRoomByPublicId(this.database, roomPublicId),
    );
    let participant: ParticipantRow | undefined;
    if (sessionToken !== undefined) {
      const found = repository.findParticipantBySessionHash(
        this.database,
        hashCapability(this.secret, sessionToken),
      );
      if (found?.roomId === room.id) participant = found;
    }
    let isHost = false;
    if (hostToken !== undefined) {
      const hostRoom = repository.findRoomByHostHash(
        this.database,
        hashCapability(this.secret, hostToken),
      );
      isHost = hostRoom?.id === room.id;
    }
    if (participant === undefined && !isHost) throw notFound();
    if (participant !== undefined) {
      repository.touchParticipant(this.database, participant.id, this.nowIso());
    }
    return { room, caller: { participant, isHost } };
  }

  requireHost(roomPublicId: string, hostToken: string | undefined): RoomRow {
    if (hostToken === undefined) throw notFound();
    const room = this.roomByHostCapability(hostToken);
    if (room.publicId !== roomPublicId) throw notFound();
    return room;
  }

  join(inviteToken: string, displayName: string, asHost: boolean): JoinedRoom {
    return this.addParticipant(this.roomByInvite(inviteToken), displayName, {
      asHost,
    });
  }

  /**
   * The host joins its own room with the host capability alone: the invite
   * token is only ever stored hashed, so it cannot be handed back to them.
   */
  joinAsHost(hostToken: string, displayName: string): JoinedRoom {
    const room = this.roomByHostCapability(hostToken);
    if (repository.findHostParticipant(this.database, room.id) !== undefined) {
      throw conflict('Host has already joined this room');
    }
    return this.addParticipant(room, displayName, { asHost: true });
  }

  private addParticipant(
    room: RoomRow,
    displayName: string,
    options: { asHost: boolean },
  ): JoinedRoom {
    if (room.state !== 'LOBBY') {
      throw conflict('Room is no longer accepting participants');
    }
    if (
      repository.countParticipants(this.database, room.id) >=
      MAX_PARTICIPANTS_PER_ROOM
    ) {
      throw new ApiError(409, 'too_many_participants', 'Room is full');
    }
    const sessionToken = issueCapability();
    const publicId = issuePublicId();
    repository.insertParticipant(this.database, {
      roomId: room.id,
      publicId,
      displayName,
      sessionTokenHash: hashCapability(this.secret, sessionToken),
      isHost: options.asHost,
      now: this.nowIso(),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'participant.joined',
      null,
      this.nowIso(),
    );
    return { participantId: publicId, sessionToken, roomId: room.publicId };
  }

  start(roomPublicId: string, hostToken: string | undefined): RoomRow {
    const room = this.requireHost(roomPublicId, hostToken);
    if (room.state !== 'LOBBY') throw conflict('Room has already started');
    const eligibleCount = repository.countParticipants(this.database, room.id);
    if (eligibleCount < 1) {
      throw conflict('At least one participant must join before starting');
    }
    const version = repository.catalogVersion(this.database);
    if (version === null) throw conflict('Catalog is empty');
    const seed = issueCapability();
    repository.startRoom(this.database, {
      roomId: room.id,
      slateSeed: seed,
      catalogVersion: version,
      catalogItemIds: selectSlate(
        repository.listCatalogIds(this.database),
        SLATE_SIZE,
        seed,
      ),
      eligibleCount,
      startedAt: this.nowIso(),
      expiresAt: this.later(VOTING_LIFETIME_MS),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'room.started',
      JSON.stringify({ eligibleCount }),
      this.nowIso(),
    );
    return this.reload(room.id);
  }

  close(roomPublicId: string, hostToken: string | undefined): RoomRow {
    const room = this.requireHost(roomPublicId, hostToken);
    if (room.state !== 'VOTING') throw conflict('Room is not voting');
    repository.markRoomComplete(
      this.database,
      room.id,
      this.nowIso(),
      true,
      this.later(COMPLETED_LIFETIME_MS),
    );
    repository.recordAudit(
      this.database,
      room.id,
      'room.closed_early',
      null,
      this.nowIso(),
    );
    return this.reload(room.id);
  }

  expire(roomPublicId: string, hostToken: string | undefined): void {
    const room = this.requireHost(roomPublicId, hostToken);
    repository.markRoomExpired(this.database, room.id);
    repository.recordAudit(
      this.database,
      room.id,
      'room.expired',
      JSON.stringify({ by: 'host' }),
      this.nowIso(),
    );
  }

  private reload(roomId: number): RoomRow {
    const room = repository.findRoomById(this.database, roomId);
    if (room === undefined) throw notFound();
    return room;
  }

  /**
   * Confirm one swipe. Retrying the same exposure with the same choice returns
   * the original confirmation; the opposite choice conflicts, because
   * confirmed votes are immutable in the MVP.
   */
  swipe(
    room: RoomRow,
    participant: ParticipantRow,
    exposurePublicId: string,
    choice: Choice,
  ): { confirmedAt: string } {
    const exposure = repository.findExposureByPublicId(
      this.database,
      exposurePublicId,
    );
    if (exposure === undefined) throw notFound();
    if (exposure.participantId !== participant.id) throw notFound();
    if (room.state !== 'VOTING') throw conflict('Room is not accepting votes');
    const existing = repository.findInteraction(this.database, exposure.id);
    if (existing !== undefined) {
      if (existing.choice !== choice) {
        throw conflict('This card was already confirmed with another choice');
      }
      return { confirmedAt: existing.confirmedAt };
    }
    const confirmedAt = this.nowIso();
    const completedAt = this.nowIso();
    const completionExpiry = this.later(COMPLETED_LIFETIME_MS);
    this.database.transaction(() => {
      repository.insertInteraction(
        this.database,
        exposure.id,
        choice,
        confirmedAt,
      );
      const eligible = room.eligibleCount ?? 0;
      const required = eligible * repository.countSlate(this.database, room.id);
      if (
        required > 0 &&
        repository.countRoomConfirmed(this.database, room.id) >= required
      ) {
        repository.markRoomComplete(
          this.database,
          room.id,
          completedAt,
          false,
          completionExpiry,
        );
      }
    })();
    return { confirmedAt };
  }

  private toCatalogItem(item: SlateItemRow): CatalogItemDto {
    return {
      catalogItemId: item.providerRef,
      title: item.title,
      year: item.releaseYear,
      synopsis: item.synopsis,
      runtimeMinutes: item.runtimeMinutes,
      contentRating: item.contentRating,
      posterRef: item.imageRef,
    };
  }

  private summarise(
    participant: ParticipantRow,
    slateSize: number,
    started: boolean,
  ): ParticipantSummary {
    return {
      participantId: participant.publicId,
      displayName: participant.displayName,
      isHost: participant.isHost,
      confirmedCount: participant.confirmedCount,
      complete: started && participant.confirmedCount >= slateSize,
    };
  }

  /**
   * Build the caller's view of a room. Other participants' choices are never
   * included; only their progress counts are.
   */
  view(room: RoomRow, caller: Caller): RoomView {
    const slateSize = repository.countSlate(this.database, room.id);
    const participants = repository.listParticipants(this.database, room.id);
    const started = room.state !== 'LOBBY';
    const you = caller.participant;
    let card: RoomView['card'] = null;
    if (room.state === 'VOTING' && you !== undefined) {
      const next = repository.nextUnconfirmedItem(
        this.database,
        you.id,
        room.id,
      );
      if (next !== undefined) {
        const exposure = repository.findOrCreateExposure(this.database, {
          participantId: you.id,
          roomItemId: next.roomItemId,
          publicId: issuePublicId(),
          shownAt: this.nowIso(),
          slateVersion: room.catalogVersion ?? 'unknown',
        });
        card = {
          exposureId: exposure.publicId,
          slatePosition: next.slatePosition,
          slateSize,
          item: this.toCatalogItem(next),
        };
      }
    }
    return {
      roomId: room.publicId,
      state: room.state,
      isHost: caller.isHost,
      closedEarly: room.closedEarly,
      slateSize,
      eligibleCount: room.eligibleCount,
      participants: participants.map((participant) =>
        this.summarise(participant, slateSize, started),
      ),
      you:
        you === undefined
          ? null
          : this.summarise(
              participants.find((participant) => participant.id === you.id) ??
                you,
              slateSize,
              started,
            ),
      card,
      resultsAvailable: room.state === 'COMPLETE',
    };
  }

  /** Canonical results, derived only from stored interactions. */
  results(room: RoomRow): ResultsResponse {
    if (room.state !== 'COMPLETE') {
      throw conflict('Results are hidden until voting ends');
    }
    const eligible = room.eligibleCount ?? 0;
    if (eligible < 1) throw conflict('Room has no eligible participants');
    const slate = repository.listSlate(this.database, room.id);
    const byRoomItem = new Map(slate.map((item) => [item.roomItemId, item]));
    const ranked = rankSlate(
      eligible,
      repository.tallies(this.database, room.id).map((tally) => ({
        item: tally.roomItemId.toString(),
        slatePosition: tally.slatePosition,
        yes: tally.yes,
        responses: tally.responses,
      })),
    );
    return {
      roomId: room.publicId,
      state: room.state,
      closedEarly: room.closedEarly,
      eligibleCount: eligible,
      completedAt: room.completedAt,
      items: ranked.map((row) => {
        const slateItem = byRoomItem.get(Number(row.item));
        if (slateItem === undefined) throw new Error('Slate item missing');
        return {
          rank: row.rank,
          catalogItemId: slateItem.providerRef,
          slatePosition: row.slatePosition,
          item: this.toCatalogItem(slateItem),
          yes: row.yes,
          responses: row.responses,
          eligible: row.eligible,
          approvalPct: row.approvalPct,
          coveragePct: row.coveragePct,
          yesFraction: row.yesFraction,
          match: row.match,
        };
      }),
    };
  }
}
