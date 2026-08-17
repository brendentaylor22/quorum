import type { CatalogItem } from '@quorum/catalog';
import type { RoomState } from '@quorum/contracts';
import type { QuorumDatabase } from '@quorum/database';
import {
  commitCatalogVersion,
  unrankedWriteItem,
} from '../catalog/repository.js';

export interface RoomRow {
  id: number;
  publicId: string;
  state: RoomState;
  catalogVersion: string | null;
  slateSeed: string | null;
  eligibleCount: number | null;
  closedEarly: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

export interface ParticipantRow {
  id: number;
  roomId: number;
  publicId: string;
  displayName: string;
  isHost: boolean;
  joinedAt: string;
  confirmedCount: number;
}

export interface SlateItemRow {
  roomItemId: number;
  slatePosition: number;
  catalogItemId: number;
  providerRef: string;
  title: string;
  releaseYear: number | null;
  synopsis: string | null;
  runtimeMinutes: number | null;
  contentRating: string | null;
  imageRef: string | null;
  genres: string[];
  reason: string | null;
  /** Recommender score, 0-1. Null on a top-rated or exploration pick. */
  score: number | null;
}

interface RawSlateItem extends Omit<SlateItemRow, 'genres'> {
  /**
   * Genre names joined by the ASCII unit separator, which no genre name can
   * contain. A single subquery keeps the slate read to one statement.
   */
  genres: string | null;
}

const GENRE_SEPARATOR = '\u001F';

/**
 * Slate columns, including the film's genres. The join is expressed as a
 * correlated subquery so one row comes back per slate item rather than one per
 * genre, which keeps `LIMIT 1` on the next-card query correct.
 */
const slateColumns = `ri.id AS roomItemId, ri.slate_position AS slatePosition,
  c.id AS catalogItemId, c.provider_ref AS providerRef, c.title AS title,
  c.release_year AS releaseYear, c.synopsis AS synopsis,
  c.runtime_minutes AS runtimeMinutes, c.content_rating AS contentRating,
  c.image_ref AS imageRef, ri.reason AS reason, ri.score AS score,
  (SELECT group_concat(g.name, char(31))
     FROM catalog_item_genres cig
     JOIN catalog_genres g ON g.id = cig.genre_id
    WHERE cig.catalog_item_id = c.id) AS genres`;

function toSlateItem(row: RawSlateItem): SlateItemRow {
  return {
    ...row,
    genres:
      row.genres === null || row.genres === ''
        ? []
        : row.genres.split(GENRE_SEPARATOR),
  };
}

/** How a round's slate was chosen. Persisted so a slate can be explained. */
export type SlateStrategy = 'TOP_RATED' | 'RECOMMENDED';

export interface RoundRow {
  id: number;
  roomId: number;
  roundNumber: number;
  slateSeed: string;
  catalogVersion: string;
  strategy: SlateStrategy;
  algorithmVersion: string | null;
  eligibleCount: number;
  startedAt: string;
  completedAt: string | null;
  closedEarly: boolean;
}

interface RawRound extends Omit<RoundRow, 'closedEarly'> {
  closedEarly: number;
}

function toRound(row: RawRound | undefined): RoundRow | undefined {
  if (row === undefined) return undefined;
  return { ...row, closedEarly: row.closedEarly === 1 };
}

const roundColumns = `id, room_id AS roomId, round_number AS roundNumber,
  slate_seed AS slateSeed, catalog_version AS catalogVersion, strategy,
  algorithm_version AS algorithmVersion, eligible_count AS eligibleCount,
  started_at AS startedAt, completed_at AS completedAt,
  closed_early AS closedEarly`;

export interface ExposureRow {
  id: number;
  publicId: string;
  participantId: number;
  roomItemId: number;
}

export interface TallyRow {
  roomItemId: number;
  slatePosition: number;
  yes: number;
  responses: number;
}

interface RawRoom {
  id: number;
  public_id: string;
  state: RoomState;
  catalog_version: string | null;
  slate_seed: string | null;
  eligible_count: number | null;
  closed_early: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

function toRoom(row: RawRoom | undefined): RoomRow | undefined {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    publicId: row.public_id,
    state: row.state,
    catalogVersion: row.catalog_version,
    slateSeed: row.slate_seed,
    eligibleCount: row.eligible_count,
    closedEarly: row.closed_early === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

const roomColumns = `id, public_id, state, catalog_version, slate_seed,
  eligible_count, closed_early, created_at, started_at, completed_at, expires_at`;

/**
 * Idempotently load a fixture catalog snapshot. The fixture carries no vote
 * data, so every item ranks equally and the candidate pool falls back to
 * stable id order.
 */
export function importCatalog(
  database: QuorumDatabase,
  items: readonly CatalogItem[],
  now: string,
): number {
  const first = items[0];
  if (first === undefined) throw new Error('Catalog import received no items');
  return commitCatalogVersion(database, {
    version: first.catalogVersion,
    provider: first.provider,
    minVoteCount: 0,
    poolMeanRating: 0,
    startedAt: now,
    completedAt: now,
    items: items.map(unrankedWriteItem),
  });
}

/**
 * How the slate candidate pool is ordered.
 *
 * Ranking on `weighted_rating` alone answers "best film of all time", and the
 * honest answer to that is a wall of restored classics and subtitled festival
 * winners. It is a defensible list and a bad first slate: a group that opened
 * the app to pick tonight's film recognises almost none of it. Two more
 * signals pull the pool back towards what people have actually seen and
 * actually might watch, without abandoning quality as the dominant term.
 *
 * - `quality` is the Bayesian rating, normalised across the installed catalog.
 * - `mainstream` is vote count, saturating: it separates a film everyone has
 *   heard of from one only critics have, and stops one blockbuster with an
 *   order of magnitude more votes than anything else owning the whole scale.
 * - `recency` is release year, normalised across the catalog's own span.
 *
 * Quality still carries the most weight, so nothing bad gets in; the other two
 * decide which of the many good films surface first.
 */
export const SLATE_POOL_WEIGHTS = {
  quality: 0.6,
  mainstream: 0.22,
  recency: 0.18,
} as const;

/**
 * Vote count at which a film scores half of the mainstream term. Set near the
 * point where a title has broken out of enthusiast audiences; well-known films
 * clear it comfortably and the curve flattens above it.
 */
export const MAINSTREAM_HALF_VOTES = 2500;

/**
 * Candidate pool for a slate: active items ranked by `SLATE_POOL_WEIGHTS` and
 * capped, so a room draws from a shortlist rather than the whole catalog.
 *
 * Every term is derived from stored columns and the pool's own bounds, and
 * ties break on `id`, so the ordering is deterministic for a given catalog
 * version — which is what makes a persisted slate seed reproducible.
 */
export function listSlateCandidateIds(
  database: QuorumDatabase,
  poolSize: number,
): number[] {
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error('Candidate pool size must be a positive integer');
  }
  return (
    database
      .prepare(
        // A degenerate catalog — one item, or every item sharing a year —
        // collapses a normalised term to zero rather than dividing by it.
        `WITH bounds AS (
           SELECT min(weighted_rating) AS lowRating,
                  max(weighted_rating) AS highRating,
                  min(release_year) AS firstYear,
                  max(release_year) AS lastYear
             FROM catalog_items
            WHERE active = 1
         )
         SELECT catalog_items.id AS id
           FROM catalog_items, bounds
          WHERE catalog_items.active = 1
          ORDER BY
            ? * (CASE WHEN bounds.highRating > bounds.lowRating
                      THEN (catalog_items.weighted_rating - bounds.lowRating)
                           / (bounds.highRating - bounds.lowRating)
                      ELSE 0 END)
          + ? * (catalog_items.vote_count * 1.0
                 / (catalog_items.vote_count + ?))
          + ? * (CASE WHEN bounds.lastYear > bounds.firstYear
                      THEN (coalesce(catalog_items.release_year, bounds.firstYear)
                            - bounds.firstYear) * 1.0
                           / (bounds.lastYear - bounds.firstYear)
                      ELSE 0 END)
            DESC, catalog_items.id
          LIMIT ?`,
      )
      .all(
        SLATE_POOL_WEIGHTS.quality,
        SLATE_POOL_WEIGHTS.mainstream,
        MAINSTREAM_HALF_VOTES,
        SLATE_POOL_WEIGHTS.recency,
        poolSize,
      ) as { id: number }[]
  ).map((row) => row.id);
}

export function catalogVersion(database: QuorumDatabase): string | null {
  const row = database
    .prepare('SELECT version FROM catalog_versions WHERE is_current = 1')
    .get() as { version: string } | undefined;
  return row?.version ?? null;
}

export interface InsertRoomInput {
  publicId: string;
  inviteTokenHash: string;
  hostTokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export function insertRoom(
  database: QuorumDatabase,
  input: InsertRoomInput,
): RoomRow {
  const result = database
    .prepare(
      `INSERT INTO rooms (public_id, state, invite_token_hash, host_token_hash, created_at, expires_at)
       VALUES (?, 'LOBBY', ?, ?, ?, ?)`,
    )
    .run(
      input.publicId,
      input.inviteTokenHash,
      input.hostTokenHash,
      input.createdAt,
      input.expiresAt,
    );
  const room = findRoomById(database, Number(result.lastInsertRowid));
  if (room === undefined) throw new Error('Room insert did not persist');
  return room;
}

export function findRoomById(
  database: QuorumDatabase,
  id: number,
): RoomRow | undefined {
  return toRoom(
    database
      .prepare(`SELECT ${roomColumns} FROM rooms WHERE id = ?`)
      .get(id) as RawRoom | undefined,
  );
}

export function findRoomByPublicId(
  database: QuorumDatabase,
  publicId: string,
): RoomRow | undefined {
  return toRoom(
    database
      .prepare(`SELECT ${roomColumns} FROM rooms WHERE public_id = ?`)
      .get(publicId) as RawRoom | undefined,
  );
}

export function findRoomByInviteHash(
  database: QuorumDatabase,
  hash: string,
): RoomRow | undefined {
  return toRoom(
    database
      .prepare(`SELECT ${roomColumns} FROM rooms WHERE invite_token_hash = ?`)
      .get(hash) as RawRoom | undefined,
  );
}

export function findRoomByHostHash(
  database: QuorumDatabase,
  hash: string,
): RoomRow | undefined {
  return toRoom(
    database
      .prepare(`SELECT ${roomColumns} FROM rooms WHERE host_token_hash = ?`)
      .get(hash) as RawRoom | undefined,
  );
}

export function markRoomExpired(
  database: QuorumDatabase,
  roomId: number,
): void {
  database
    .prepare(
      `UPDATE rooms SET state = 'EXPIRED', invite_token_hash = 'revoked:' || public_id,
       host_token_hash = 'revoked-host:' || public_id WHERE id = ?`,
    )
    .run(roomId);
}

export function markRoomComplete(
  database: QuorumDatabase,
  roomId: number,
  completedAt: string,
  closedEarly: boolean,
  expiresAt: string,
): void {
  database
    .prepare(
      `UPDATE rooms SET state = 'COMPLETE', completed_at = ?, closed_early = ?, expires_at = ?
       WHERE id = ? AND state = 'VOTING'`,
    )
    .run(completedAt, closedEarly ? 1 : 0, expiresAt, roomId);
}

export interface JoinInput {
  roomId: number;
  publicId: string;
  displayName: string;
  sessionTokenHash: string;
  isHost: boolean;
  now: string;
}

export function insertParticipant(
  database: QuorumDatabase,
  input: JoinInput,
): number {
  const result = database
    .prepare(
      `INSERT INTO participants
         (room_id, public_id, display_name, session_token_hash, is_host, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.roomId,
      input.publicId,
      input.displayName,
      input.sessionTokenHash,
      input.isHost ? 1 : 0,
      input.now,
      input.now,
    );
  return Number(result.lastInsertRowid);
}

const participantColumns = `p.id AS id, p.room_id AS roomId, p.public_id AS publicId,
  p.display_name AS displayName, p.is_host AS isHost, p.joined_at AS joinedAt,
  (SELECT count(*) FROM exposures e
     JOIN interactions i ON i.exposure_id = e.id
    WHERE e.participant_id = p.id) AS confirmedCount`;

interface RawParticipant extends Omit<ParticipantRow, 'isHost'> {
  isHost: number;
}

function toParticipant(row: RawParticipant): ParticipantRow {
  return { ...row, isHost: row.isHost === 1 };
}

export function listParticipants(
  database: QuorumDatabase,
  roomId: number,
): ParticipantRow[] {
  return (
    database
      .prepare(
        `SELECT ${participantColumns} FROM participants p
          WHERE p.room_id = ? ORDER BY p.id`,
      )
      .all(roomId) as RawParticipant[]
  ).map(toParticipant);
}

export function findHostParticipant(
  database: QuorumDatabase,
  roomId: number,
): ParticipantRow | undefined {
  const row = database
    .prepare(
      `SELECT ${participantColumns} FROM participants p
        WHERE p.room_id = ? AND p.is_host = 1 ORDER BY p.id LIMIT 1`,
    )
    .get(roomId) as RawParticipant | undefined;
  return row === undefined ? undefined : toParticipant(row);
}

export function countParticipants(
  database: QuorumDatabase,
  roomId: number,
): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM participants WHERE room_id = ?')
    .get(roomId) as { count: number };
  return row.count;
}

export function findParticipantBySessionHash(
  database: QuorumDatabase,
  hash: string,
): ParticipantRow | undefined {
  const row = database
    .prepare(
      `SELECT ${participantColumns} FROM participants p WHERE p.session_token_hash = ?`,
    )
    .get(hash) as RawParticipant | undefined;
  return row === undefined ? undefined : toParticipant(row);
}

export function touchParticipant(
  database: QuorumDatabase,
  participantId: number,
  now: string,
): void {
  database
    .prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?')
    .run(now, participantId);
}

export interface StartRoundInput {
  roomId: number;
  roundNumber: number;
  slateSeed: string;
  catalogVersion: string;
  strategy: SlateStrategy;
  algorithmVersion: string | null;
  /**
   * Catalog ids in slate order, each with the reason and score that put it
   * there. Both are null on a top-rated slate.
   */
  slate: readonly {
    catalogItemId: number;
    reason: string | null;
    score: number | null;
  }[];
  eligibleCount: number;
  startedAt: string;
  expiresAt: string;
}

/**
 * Open a round: freeze its participant count and slate, and put the room back
 * into voting. The unique constraint on `(room_id, catalog_item_id)` is what
 * stops a later round re-showing a movie the group has already judged, so a
 * repeat fails loudly here rather than reaching a participant.
 */
export function startRound(
  database: QuorumDatabase,
  input: StartRoundInput,
): RoundRow {
  const insertItem = database.prepare(
    `INSERT INTO room_items (room_id, round_id, catalog_item_id, slate_position, reason, score)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return database.transaction(() => {
    const updated = database
      .prepare(
        `UPDATE rooms SET state = 'VOTING', started_at = coalesce(started_at, ?),
           slate_seed = ?, catalog_version = ?, eligible_count = ?,
           completed_at = NULL, closed_early = 0, expires_at = ?
         WHERE id = ? AND state IN ('LOBBY', 'COMPLETE')`,
      )
      .run(
        input.startedAt,
        input.slateSeed,
        input.catalogVersion,
        input.eligibleCount,
        input.expiresAt,
        input.roomId,
      );
    if (updated.changes !== 1) {
      throw new Error('Room cannot start a round in its current state');
    }
    const result = database
      .prepare(
        `INSERT INTO rounds (
           room_id, round_number, slate_seed, catalog_version, strategy,
           algorithm_version, eligible_count, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roomId,
        input.roundNumber,
        input.slateSeed,
        input.catalogVersion,
        input.strategy,
        input.algorithmVersion,
        input.eligibleCount,
        input.startedAt,
      );
    const roundId = Number(result.lastInsertRowid);
    input.slate.forEach((entry, index) => {
      insertItem.run(
        input.roomId,
        roundId,
        entry.catalogItemId,
        index + 1,
        entry.reason,
        entry.score,
      );
    });
    const round = findRoundById(database, roundId);
    if (round === undefined) throw new Error('Round did not persist');
    return round;
  })();
}

export function findRoundById(
  database: QuorumDatabase,
  id: number,
): RoundRow | undefined {
  return toRound(
    database
      .prepare(`SELECT ${roundColumns} FROM rounds WHERE id = ?`)
      .get(id) as RawRound | undefined,
  );
}

/** The room's most recent round, whether or not it has completed. */
export function currentRound(
  database: QuorumDatabase,
  roomId: number,
): RoundRow | undefined {
  return toRound(
    database
      .prepare(
        `SELECT ${roundColumns} FROM rounds WHERE room_id = ?
          ORDER BY round_number DESC LIMIT 1`,
      )
      .get(roomId) as RawRound | undefined,
  );
}

export function findRound(
  database: QuorumDatabase,
  roomId: number,
  roundNumber: number,
): RoundRow | undefined {
  return toRound(
    database
      .prepare(
        `SELECT ${roundColumns} FROM rounds WHERE room_id = ? AND round_number = ?`,
      )
      .get(roomId, roundNumber) as RawRound | undefined,
  );
}

export function listRounds(
  database: QuorumDatabase,
  roomId: number,
): RoundRow[] {
  return (
    database
      .prepare(
        `SELECT ${roundColumns} FROM rounds WHERE room_id = ? ORDER BY round_number`,
      )
      .all(roomId) as RawRound[]
  ).map((row) => {
    const round = toRound(row);
    if (round === undefined) throw new Error('Round row did not map');
    return round;
  });
}

/** Close a round and the room together; results become readable. */
export function markRoundComplete(
  database: QuorumDatabase,
  input: {
    roomId: number;
    roundId: number;
    completedAt: string;
    closedEarly: boolean;
    expiresAt: string;
  },
): void {
  database.transaction(() => {
    database
      .prepare(
        `UPDATE rounds SET completed_at = ?, closed_early = ?
          WHERE id = ? AND completed_at IS NULL`,
      )
      .run(input.completedAt, input.closedEarly ? 1 : 0, input.roundId);
    database
      .prepare(
        `UPDATE rooms SET state = 'COMPLETE', completed_at = ?, closed_early = ?,
           expires_at = ?
         WHERE id = ? AND state = 'VOTING'`,
      )
      .run(
        input.completedAt,
        input.closedEarly ? 1 : 0,
        input.expiresAt,
        input.roomId,
      );
  })();
}

/** Catalog items already shown in this room, across every round. */
export function listRoomCatalogItemIds(
  database: QuorumDatabase,
  roomId: number,
): number[] {
  return (
    database
      .prepare('SELECT catalog_item_id AS id FROM room_items WHERE room_id = ?')
      .all(roomId) as { id: number }[]
  ).map((row) => row.id);
}

export function listSlate(
  database: QuorumDatabase,
  roundId: number,
): SlateItemRow[] {
  return (
    database
      .prepare(
        `SELECT ${slateColumns}
         FROM room_items ri
         JOIN catalog_items c ON c.id = ri.catalog_item_id
        WHERE ri.round_id = ?
        ORDER BY ri.slate_position`,
      )
      .all(roundId) as RawSlateItem[]
  ).map(toSlateItem);
}

export function countSlate(database: QuorumDatabase, roundId: number): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM room_items WHERE round_id = ?')
    .get(roundId) as { count: number };
  return row.count;
}

/** First item of this round the participant has not confirmed, in slate order. */
export function nextUnconfirmedItem(
  database: QuorumDatabase,
  participantId: number,
  roundId: number,
): SlateItemRow | undefined {
  const row = database
    .prepare(
      `SELECT ${slateColumns}
         FROM room_items ri
         JOIN catalog_items c ON c.id = ri.catalog_item_id
        WHERE ri.round_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM exposures e
              JOIN interactions i ON i.exposure_id = e.id
             WHERE e.room_item_id = ri.id AND e.participant_id = ?
          )
        ORDER BY ri.slate_position
        LIMIT 1`,
    )
    .get(roundId, participantId) as RawSlateItem | undefined;
  return row === undefined ? undefined : toSlateItem(row);
}

/**
 * Exposure identity is stable per participant and slate item, which makes
 * swipe confirmation idempotent across retries and reconnects.
 */
export function findOrCreateExposure(
  database: QuorumDatabase,
  input: {
    participantId: number;
    roomItemId: number;
    publicId: string;
    shownAt: string;
    slateVersion: string;
  },
): ExposureRow {
  database
    .prepare(
      `INSERT INTO exposures (public_id, participant_id, room_item_id, context, shown_at, slate_version)
       VALUES (?, ?, ?, 'WATCH_NOW', ?, ?)
       ON CONFLICT (participant_id, room_item_id) DO NOTHING`,
    )
    .run(
      input.publicId,
      input.participantId,
      input.roomItemId,
      input.shownAt,
      input.slateVersion,
    );
  const row = database
    .prepare(
      `SELECT id, public_id AS publicId, participant_id AS participantId,
              room_item_id AS roomItemId
         FROM exposures WHERE participant_id = ? AND room_item_id = ?`,
    )
    .get(input.participantId, input.roomItemId) as ExposureRow | undefined;
  if (row === undefined) throw new Error('Exposure did not persist');
  return row;
}

export function findExposureByPublicId(
  database: QuorumDatabase,
  publicId: string,
): ExposureRow | undefined {
  return database
    .prepare(
      `SELECT id, public_id AS publicId, participant_id AS participantId,
              room_item_id AS roomItemId
         FROM exposures WHERE public_id = ?`,
    )
    .get(publicId) as ExposureRow | undefined;
}

export interface InteractionRow {
  choice: 'LEFT' | 'RIGHT';
  confirmedAt: string;
}

export function findInteraction(
  database: QuorumDatabase,
  exposureId: number,
): InteractionRow | undefined {
  return database
    .prepare(
      'SELECT choice, confirmed_at AS confirmedAt FROM interactions WHERE exposure_id = ?',
    )
    .get(exposureId) as InteractionRow | undefined;
}

export function insertInteraction(
  database: QuorumDatabase,
  exposureId: number,
  choice: 'LEFT' | 'RIGHT',
  confirmedAt: string,
): void {
  database
    .prepare(
      'INSERT INTO interactions (exposure_id, choice, confirmed_at) VALUES (?, ?, ?)',
    )
    .run(exposureId, choice, confirmedAt);
}

/** Confirmations by one participant within one round. */
export function countConfirmedInRound(
  database: QuorumDatabase,
  participantId: number,
  roundId: number,
): number {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM exposures e
         JOIN interactions i ON i.exposure_id = e.id
         JOIN room_items ri ON ri.id = e.room_item_id
        WHERE e.participant_id = ? AND ri.round_id = ?`,
    )
    .get(participantId, roundId) as { count: number };
  return row.count;
}

export function countRoundConfirmed(
  database: QuorumDatabase,
  roundId: number,
): number {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM interactions i
         JOIN exposures e ON e.id = i.exposure_id
         JOIN room_items ri ON ri.id = e.room_item_id
        WHERE ri.round_id = ?`,
    )
    .get(roundId) as { count: number };
  return row.count;
}

export function tallies(database: QuorumDatabase, roundId: number): TallyRow[] {
  return database
    .prepare(
      `SELECT ri.id AS roomItemId, ri.slate_position AS slatePosition,
              coalesce(sum(CASE WHEN i.choice = 'RIGHT' THEN 1 ELSE 0 END), 0) AS yes,
              count(i.id) AS responses
         FROM room_items ri
         LEFT JOIN exposures e ON e.room_item_id = ri.id
         LEFT JOIN interactions i ON i.exposure_id = e.id
        WHERE ri.round_id = ?
        GROUP BY ri.id
        ORDER BY ri.slate_position`,
    )
    .all(roundId) as TallyRow[];
}

export function recordAudit(
  database: QuorumDatabase,
  roomId: number | null,
  event: string,
  detail: string | null,
  now: string,
): void {
  database
    .prepare(
      'INSERT INTO audit_events (room_id, event, detail, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(roomId, event, detail, now);
}

/** Rooms past their retention window, used by lazy and scheduled expiry. */
export function listExpiredRoomIds(
  database: QuorumDatabase,
  now: string,
): number[] {
  return (
    database
      .prepare(
        `SELECT id FROM rooms WHERE state != 'EXPIRED' AND expires_at <= ?`,
      )
      .all(now) as { id: number }[]
  ).map((row) => row.id);
}

export interface RoomInteractionRow {
  participantId: number;
  catalogItemId: number;
  choice: 'LEFT' | 'RIGHT';
}

/**
 * Every confirmed swipe in a room, across all rounds. This is the
 * recommender's only input: the group's own judgements, keyed by participant
 * so a per-person profile can be built before any group aggregation.
 */
export function listRoomInteractions(
  database: QuorumDatabase,
  roomId: number,
): RoomInteractionRow[] {
  return database
    .prepare(
      `SELECT e.participant_id AS participantId,
              ri.catalog_item_id AS catalogItemId,
              i.choice AS choice
         FROM interactions i
         JOIN exposures e ON e.id = i.exposure_id
         JOIN room_items ri ON ri.id = e.room_item_id
        WHERE ri.room_id = ?
        ORDER BY i.id`,
    )
    .all(roomId) as RoomInteractionRow[];
}
