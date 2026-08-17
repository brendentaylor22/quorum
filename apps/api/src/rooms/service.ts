import { loadFixtureCatalog, selectSlate } from '@quorum/catalog';
import {
  MAX_PARTICIPANTS_PER_ROOM,
  SLATE_CANDIDATE_POOL_SIZE,
  SLATE_SIZE,
  type CatalogItemDto,
  type CatalogSource,
  type Choice,
  type ErrorCode,
  type ParticipantSummary,
  type ResultsResponse,
  type RoomView,
} from '@quorum/contracts';
import type { QuorumDatabase } from '@quorum/database';
import { rankSlate } from '@quorum/ranking';
import {
  RECOMMENDER_VERSION,
  selectRecommendedSlate,
  type Judgement,
} from '@quorum/recommend';
import { catalogFeatures } from '../catalog/features.js';
import { TMDB_ATTRIBUTION, TMDB_PROVIDER, posterUrl } from '@quorum/tmdb';
import { catalogStatus } from '../catalog/repository.js';
import {
  hashCapability,
  issueCapability,
  issuePublicId,
} from '../capabilities.js';
import * as repository from './repository.js';
import type { ParticipantRow, RoomRow, SlateItemRow } from './repository.js';

/**
 * Candidate pool for a recommended round. Wider than the top-rated pool
 * because everything the room has already judged is excluded from it.
 */
const RECOMMENDER_POOL_SIZE = 2000;

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
  private imageConfigCache:
    | {
        version: string | null;
        value: { baseUrl: string; size: string } | null;
      }
    | undefined;

  constructor(options: RoomServiceOptions) {
    this.database = options.database;
    this.secret = options.secret;
    this.clock = options.now ?? (() => new Date());
  }

  /**
   * Describe the installed catalog. The attribution string is chosen from the
   * provider that actually produced the rows, so a fixture build never claims
   * to be showing TMDB data and a TMDB build always carries the required
   * notice.
   */
  catalogSource(): CatalogSource {
    const status = catalogStatus(this.database);
    const provider = status.current?.provider ?? null;
    return {
      provider,
      version: status.current?.version ?? null,
      itemCount: status.activeItems,
      attribution: provider === TMDB_PROVIDER ? TMDB_ATTRIBUTION : null,
      imageBaseUrl: status.current?.imageBaseUrl ?? null,
    };
  }

  /**
   * Poster delivery details for the installed catalog, memoised per catalog
   * version. Every card and every result row needs them, and they only change
   * when a new catalog is installed.
   */
  private imageConfig(): { baseUrl: string; size: string } | null {
    const status = catalogStatus(this.database);
    const version = status.current?.version ?? null;
    if (this.imageConfigCache?.version !== version) {
      const baseUrl = status.current?.imageBaseUrl ?? null;
      this.imageConfigCache = {
        version,
        value:
          baseUrl === null
            ? null
            : { baseUrl, size: status.current?.posterSize ?? 'w500' },
      };
    }
    return this.imageConfigCache.value;
  }

  /**
   * Seed the fixture catalog, unless a real one is installed.
   *
   * This runs on every boot so a fresh checkout has movies to vote on. It must
   * never overwrite an imported catalog: committing a version deactivates
   * every other row, so seeding unconditionally would silently revert a TMDB
   * import to fixtures on the next restart. A fixture catalog is still
   * refreshed, so widening the fixture takes effect without a manual step.
   */
  seedFixtureCatalog(): number {
    const installed = catalogStatus(this.database).current;
    const fixture = loadFixtureCatalog();
    const fixtureProvider = fixture[0]?.provider;
    if (
      installed !== null &&
      installed.provider !== fixtureProvider &&
      installed.itemCount > 0
    ) {
      return 0;
    }
    return repository.importCatalog(this.database, fixture, this.nowIso());
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

  /** Open round 1: 20 drawn at random from the slate candidate pool. */
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
    const pool = repository.listSlateCandidateIds(
      this.database,
      SLATE_CANDIDATE_POOL_SIZE,
    );
    if (pool.length < SLATE_SIZE) {
      throw conflict('Catalog does not hold enough movies for a slate');
    }
    repository.startRound(this.database, {
      roomId: room.id,
      roundNumber: 1,
      slateSeed: seed,
      catalogVersion: version,
      strategy: 'TOP_RATED',
      algorithmVersion: null,
      slate: selectSlate(pool, SLATE_SIZE, seed).map((catalogItemId) => ({
        catalogItemId,
        reason: null,
        score: null,
      })),
      eligibleCount,
      startedAt: this.nowIso(),
      expiresAt: this.later(VOTING_LIFETIME_MS),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'round.started',
      JSON.stringify({ roundNumber: 1, strategy: 'TOP_RATED', eligibleCount }),
      this.nowIso(),
    );
    return this.reload(room.id);
  }

  /**
   * Open another round from what the group has already told us.
   *
   * Membership refreezes at the current participant count, so each round's
   * percentages have their own honest denominator. Movies already judged in
   * this room are excluded, which the schema also enforces.
   */
  continueVoting(roomPublicId: string, hostToken: string | undefined): RoomRow {
    const room = this.requireHost(roomPublicId, hostToken);
    if (room.state !== 'COMPLETE') {
      throw conflict('Voting is still open');
    }
    const previous = repository.currentRound(this.database, room.id);
    if (previous === undefined) throw conflict('Room has no completed round');
    const eligibleCount = repository.countParticipants(this.database, room.id);
    if (eligibleCount < 1) {
      throw conflict('Room has no participants');
    }
    const version = repository.catalogVersion(this.database);
    if (version === null) throw conflict('Catalog is empty');

    const seed = issueCapability();
    const slate = this.recommendSlate(room.id, seed);
    if (slate.length < SLATE_SIZE) {
      throw conflict('Not enough unseen movies remain for another round');
    }
    repository.startRound(this.database, {
      roomId: room.id,
      roundNumber: previous.roundNumber + 1,
      slateSeed: seed,
      catalogVersion: version,
      strategy: 'RECOMMENDED',
      algorithmVersion: RECOMMENDER_VERSION,
      slate,
      eligibleCount,
      startedAt: this.nowIso(),
      expiresAt: this.later(VOTING_LIFETIME_MS),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'round.started',
      JSON.stringify({
        roundNumber: previous.roundNumber + 1,
        strategy: 'RECOMMENDED',
        algorithmVersion: RECOMMENDER_VERSION,
        eligibleCount,
      }),
      this.nowIso(),
    );
    return this.reload(room.id);
  }

  close(roomPublicId: string, hostToken: string | undefined): RoomRow {
    const room = this.requireHost(roomPublicId, hostToken);
    if (room.state !== 'VOTING') throw conflict('Room is not voting');
    const round = repository.currentRound(this.database, room.id);
    if (round === undefined) throw conflict('Room has no open round');
    repository.markRoundComplete(this.database, {
      roomId: room.id,
      roundId: round.id,
      completedAt: this.nowIso(),
      closedEarly: true,
      expiresAt: this.later(COMPLETED_LIFETIME_MS),
    });
    repository.recordAudit(
      this.database,
      room.id,
      'round.closed_early',
      JSON.stringify({ roundNumber: round.roundNumber }),
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
    const round = repository.currentRound(this.database, room.id);
    if (round === undefined) throw conflict('Room has no open round');
    const existing = repository.findInteraction(this.database, exposure.id);
    if (existing !== undefined) {
      if (existing.choice !== choice) {
        throw conflict('This card was already confirmed with another choice');
      }
      return { confirmedAt: existing.confirmedAt };
    }
    const confirmedAt = this.nowIso();
    const completionExpiry = this.later(COMPLETED_LIFETIME_MS);
    this.database.transaction(() => {
      repository.insertInteraction(
        this.database,
        exposure.id,
        choice,
        confirmedAt,
      );
      // A round closes once its own frozen membership has answered its own
      // slate; earlier rounds are already closed and must not be counted.
      const required =
        round.eligibleCount * repository.countSlate(this.database, round.id);
      if (
        required > 0 &&
        repository.countRoundConfirmed(this.database, round.id) >= required
      ) {
        repository.markRoundComplete(this.database, {
          roomId: room.id,
          roundId: round.id,
          completedAt: confirmedAt,
          closedEarly: false,
          expiresAt: completionExpiry,
        });
      }
    })();
    return { confirmedAt };
  }

  /**
   * Build the next slate from the room's own swipes.
   *
   * Only this room's confirmed interactions are used. Nothing crosses room
   * boundaries, so anonymous history stays room-scoped exactly as the data
   * model promises.
   */
  private recommendSlate(
    roomId: number,
    seed: string,
  ): { catalogItemId: number; reason: string | null; score: number | null }[] {
    const candidateIds = this.unseenCandidates(roomId);
    if (candidateIds.length < SLATE_SIZE) return [];

    const interactions = repository.listRoomInteractions(this.database, roomId);
    const judgements: Judgement[] = interactions.map((row) => ({
      participant: row.participantId.toString(),
      item: row.catalogItemId.toString(),
      liked: row.choice === 'RIGHT',
    }));
    const judgedItems = catalogFeatures(this.database, [
      ...new Set(interactions.map((row) => row.catalogItemId)),
    ]);
    const candidates = catalogFeatures(this.database, candidateIds);

    const selected = selectRecommendedSlate(
      judgements,
      judgedItems,
      candidates,
      { size: SLATE_SIZE, seed },
    );
    const labels = this.tagLabels(selected.flatMap((entry) => entry.topTags));
    return selected.map((entry) => ({
      catalogItemId: Number(entry.item),
      reason: describeSelection(entry, labels),
      // An exploration slot was not scored, and reporting its zero as a
      // prediction would misrepresent a random pick as a confident one.
      score: entry.exploration ? null : entry.score,
    }));
  }

  /**
   * Human names for tags that came from the catalog, so a reason can read
   * "Action" rather than "genre:28".
   */
  private tagLabels(tags: readonly string[]): Map<string, string> {
    const labels = new Map<string, string>();
    const genreIds: number[] = [];
    const keywordIds: number[] = [];
    for (const tag of new Set(tags)) {
      const [namespace, value] = tag.split(':');
      if (value === undefined) continue;
      if (namespace === 'genre') genreIds.push(Number(value));
      else if (namespace === 'keyword') keywordIds.push(Number(value));
      else if (namespace === 'decade') labels.set(tag, `${value}s`);
      else if (namespace === 'runtime') labels.set(tag, `${value} films`);
    }
    for (const [table, ids, namespace] of [
      ['catalog_genres', genreIds, 'genre'],
      ['catalog_keywords', keywordIds, 'keyword'],
    ] as const) {
      if (ids.length === 0) continue;
      const rows = this.database
        .prepare(
          `SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { id: number; name: string }[];
      for (const row of rows) {
        labels.set(`${namespace}:${row.id.toString()}`, row.name);
      }
    }
    return labels;
  }

  private toCatalogItem(item: SlateItemRow): CatalogItemDto {
    const images = this.imageConfig();
    return {
      catalogItemId: item.providerRef,
      title: item.title,
      year: item.releaseYear,
      synopsis: item.synopsis,
      runtimeMinutes: item.runtimeMinutes,
      contentRating: item.contentRating,
      genres: item.genres,
      posterRef: item.imageRef,
      // A fixture reference is not a provider path, so it yields no URL and
      // the client falls back to its placeholder tile.
      posterUrl:
        images === null || item.imageRef?.startsWith('/') !== true
          ? null
          : posterUrl(item.imageRef, {
              baseUrl: images.baseUrl,
              size: images.size,
            }),
    };
  }

  private summarise(
    participant: ParticipantRow,
    confirmedCount: number,
    slateSize: number,
    started: boolean,
  ): ParticipantSummary {
    return {
      participantId: participant.publicId,
      displayName: participant.displayName,
      isHost: participant.isHost,
      confirmedCount,
      complete: started && slateSize > 0 && confirmedCount >= slateSize,
    };
  }

  /**
   * Build the caller's view of a room. Other participants' choices are never
   * included; only their progress counts are.
   *
   * Progress is scoped to the current round, so opening a second round resets
   * everyone's counter rather than carrying round one's totals forward.
   */
  view(room: RoomRow, caller: Caller): RoomView {
    const round = repository.currentRound(this.database, room.id);
    const slateSize =
      round === undefined ? 0 : repository.countSlate(this.database, round.id);
    const participants = repository.listParticipants(this.database, room.id);
    const started = room.state !== 'LOBBY';
    const you = caller.participant;

    const confirmedIn = (participantId: number): number =>
      round === undefined
        ? 0
        : repository.countConfirmedInRound(
            this.database,
            participantId,
            round.id,
          );

    let card: RoomView['card'] = null;
    if (room.state === 'VOTING' && you !== undefined && round !== undefined) {
      const next = repository.nextUnconfirmedItem(
        this.database,
        you.id,
        round.id,
      );
      if (next !== undefined) {
        const exposure = repository.findOrCreateExposure(this.database, {
          participantId: you.id,
          roomItemId: next.roomItemId,
          publicId: issuePublicId(),
          shownAt: this.nowIso(),
          slateVersion: round.catalogVersion,
        });
        card = {
          exposureId: exposure.publicId,
          slatePosition: next.slatePosition,
          slateSize,
          item: this.toCatalogItem(next),
          reason: next.reason,
          score: toScorePercent(next.score),
        };
      }
    }

    const rounds = repository.listRounds(this.database, room.id);
    const completedRounds = rounds
      .filter((entry) => entry.completedAt !== null)
      .map((entry) => entry.roundNumber);

    return {
      roomId: room.publicId,
      state: room.state,
      isHost: caller.isHost,
      closedEarly: room.closedEarly,
      slateSize,
      eligibleCount: round?.eligibleCount ?? room.eligibleCount,
      participants: participants.map((participant) =>
        this.summarise(
          participant,
          confirmedIn(participant.id),
          slateSize,
          started,
        ),
      ),
      you:
        you === undefined
          ? null
          : this.summarise(
              participants.find((participant) => participant.id === you.id) ??
                you,
              confirmedIn(you.id),
              slateSize,
              started,
            ),
      card,
      resultsAvailable: completedRounds.length > 0,
      round:
        round === undefined
          ? null
          : {
              roundNumber: round.roundNumber,
              strategy: round.strategy,
              slateSize,
              complete: round.completedAt !== null,
            },
      completedRounds,
      canContinue: caller.isHost && this.canContinue(room),
    };
  }

  /** Whether another round could be built right now. */
  private canContinue(room: RoomRow): boolean {
    if (room.state !== 'COMPLETE') return false;
    return this.unseenCandidates(room.id).length >= SLATE_SIZE;
  }

  /** Active catalog items this room has not already put in front of anyone. */
  private unseenCandidates(roomId: number): number[] {
    const seen = new Set(
      repository.listRoomCatalogItemIds(this.database, roomId),
    );
    return repository
      .listSlateCandidateIds(this.database, RECOMMENDER_POOL_SIZE)
      .filter((id) => !seen.has(id));
  }

  /**
   * Canonical results for one round, derived only from stored interactions.
   * Defaults to the most recently completed round.
   */
  results(room: RoomRow, roundNumber?: number): ResultsResponse {
    const rounds = repository.listRounds(this.database, room.id);
    const completed = rounds.filter((entry) => entry.completedAt !== null);
    if (completed.length === 0) {
      throw conflict('Results are hidden until voting ends');
    }
    const round =
      roundNumber === undefined
        ? completed[completed.length - 1]
        : completed.find((entry) => entry.roundNumber === roundNumber);
    if (round === undefined) throw notFound();

    const eligible = round.eligibleCount;
    if (eligible < 1) throw conflict('Round has no eligible participants');
    const slate = repository.listSlate(this.database, round.id);
    const byRoomItem = new Map(slate.map((item) => [item.roomItemId, item]));
    const ranked = rankSlate(
      eligible,
      repository.tallies(this.database, round.id).map((tally) => ({
        item: tally.roomItemId.toString(),
        slatePosition: tally.slatePosition,
        yes: tally.yes,
        responses: tally.responses,
      })),
    );
    return {
      roomId: room.publicId,
      state: room.state,
      closedEarly: round.closedEarly,
      eligibleCount: eligible,
      completedAt: round.completedAt,
      roundNumber: round.roundNumber,
      strategy: round.strategy,
      completedRounds: completed.map((entry) => entry.roundNumber),
      items: ranked.map((row) => {
        const slateItem = byRoomItem.get(Number(row.item));
        if (slateItem === undefined) throw new Error('Slate item missing');
        return {
          rank: row.rank,
          catalogItemId: slateItem.providerRef,
          slatePosition: row.slatePosition,
          item: this.toCatalogItem(slateItem),
          reason: slateItem.reason,
          score: toScorePercent(slateItem.score),
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

/**
 * The recommender's 0-1 score as a whole percentage, which is the only form
 * the client shows. Clamped because a scoring change must never produce a
 * value the contract rejects.
 */
function toScorePercent(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  return Math.min(100, Math.max(0, Math.round(score * 100)));
}

/**
 * A short, honest explanation of why an item is on the slate. Exploration
 * picks say so rather than inventing a preference that did not drive them.
 */
function describeSelection(
  entry: { exploration: boolean; supporters: number; topTags: string[] },
  labels: ReadonlyMap<string, string>,
): string {
  if (entry.exploration) return 'Something different';
  const named = entry.topTags
    .map((tag) => labels.get(tag))
    .filter((name): name is string => name !== undefined);
  if (named.length === 0) {
    return entry.supporters > 0
      ? `Looks right for ${entry.supporters.toString()} of you`
      : 'Broadly agreeable';
  }
  const because = named.join(' and ');
  return entry.supporters > 0
    ? `${because}, for ${entry.supporters.toString()} of you`
    : because;
}
