import type { CatalogItem } from '@quorum/catalog';
import type { RoomState } from '@quorum/contracts';
import type { QuorumDatabase } from '@quorum/database';

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
}

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

/** Idempotently load the catalog snapshot used to build slates. */
export function importCatalog(
  database: QuorumDatabase,
  items: readonly CatalogItem[],
  now: string,
): number {
  const insert = database.prepare(
    `INSERT INTO catalog_items (
       provider, provider_ref, media_type, title, release_year, synopsis,
       runtime_minutes, content_rating, language, image_ref, catalog_version,
       source_fetched_at, imported_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_ref) DO UPDATE SET
       title = excluded.title,
       release_year = excluded.release_year,
       synopsis = excluded.synopsis,
       runtime_minutes = excluded.runtime_minutes,
       content_rating = excluded.content_rating,
       language = excluded.language,
       image_ref = excluded.image_ref,
       catalog_version = excluded.catalog_version,
       source_fetched_at = excluded.source_fetched_at`,
  );
  return database.transaction(() => {
    for (const item of items) {
      insert.run(
        item.provider,
        item.providerRef,
        item.mediaType,
        item.title,
        item.releaseYear,
        item.synopsis,
        item.runtimeMinutes,
        item.contentRating,
        item.language,
        item.posterRef,
        item.catalogVersion,
        item.sourceFetchedAt,
        now,
      );
    }
    return items.length;
  })();
}

export function listCatalogIds(database: QuorumDatabase): number[] {
  return (
    database.prepare('SELECT id FROM catalog_items ORDER BY id').all() as {
      id: number;
    }[]
  ).map((row) => row.id);
}

export function catalogVersion(database: QuorumDatabase): string | null {
  const row = database
    .prepare(
      'SELECT catalog_version AS version FROM catalog_items ORDER BY id LIMIT 1',
    )
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

export interface StartRoomInput {
  roomId: number;
  slateSeed: string;
  catalogVersion: string;
  catalogItemIds: readonly number[];
  eligibleCount: number;
  startedAt: string;
  expiresAt: string;
}

/** Freeze membership and slate atomically. */
export function startRoom(
  database: QuorumDatabase,
  input: StartRoomInput,
): void {
  const insertItem = database.prepare(
    'INSERT INTO room_items (room_id, catalog_item_id, slate_position) VALUES (?, ?, ?)',
  );
  database.transaction(() => {
    const updated = database
      .prepare(
        `UPDATE rooms SET state = 'VOTING', started_at = ?, slate_seed = ?,
           catalog_version = ?, eligible_count = ?, expires_at = ?
         WHERE id = ? AND state = 'LOBBY'`,
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
      throw new Error('Room is no longer in the lobby');
    }
    input.catalogItemIds.forEach((catalogItemId, index) => {
      insertItem.run(input.roomId, catalogItemId, index + 1);
    });
  })();
}

export function listSlate(
  database: QuorumDatabase,
  roomId: number,
): SlateItemRow[] {
  return database
    .prepare(
      `SELECT ri.id AS roomItemId, ri.slate_position AS slatePosition,
              c.id AS catalogItemId, c.provider_ref AS providerRef, c.title AS title,
              c.release_year AS releaseYear, c.synopsis AS synopsis,
              c.runtime_minutes AS runtimeMinutes, c.content_rating AS contentRating,
              c.image_ref AS imageRef
         FROM room_items ri
         JOIN catalog_items c ON c.id = ri.catalog_item_id
        WHERE ri.room_id = ?
        ORDER BY ri.slate_position`,
    )
    .all(roomId) as SlateItemRow[];
}

export function countSlate(database: QuorumDatabase, roomId: number): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM room_items WHERE room_id = ?')
    .get(roomId) as { count: number };
  return row.count;
}

/** First slate item the participant has not confirmed, in persisted order. */
export function nextUnconfirmedItem(
  database: QuorumDatabase,
  participantId: number,
  roomId: number,
): SlateItemRow | undefined {
  return database
    .prepare(
      `SELECT ri.id AS roomItemId, ri.slate_position AS slatePosition,
              c.id AS catalogItemId, c.provider_ref AS providerRef, c.title AS title,
              c.release_year AS releaseYear, c.synopsis AS synopsis,
              c.runtime_minutes AS runtimeMinutes, c.content_rating AS contentRating,
              c.image_ref AS imageRef
         FROM room_items ri
         JOIN catalog_items c ON c.id = ri.catalog_item_id
        WHERE ri.room_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM exposures e
              JOIN interactions i ON i.exposure_id = e.id
             WHERE e.room_item_id = ri.id AND e.participant_id = ?
          )
        ORDER BY ri.slate_position
        LIMIT 1`,
    )
    .get(roomId, participantId) as SlateItemRow | undefined;
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

export function countConfirmed(
  database: QuorumDatabase,
  participantId: number,
): number {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM exposures e
         JOIN interactions i ON i.exposure_id = e.id
        WHERE e.participant_id = ?`,
    )
    .get(participantId) as { count: number };
  return row.count;
}

export function countRoomConfirmed(
  database: QuorumDatabase,
  roomId: number,
): number {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM interactions i
         JOIN exposures e ON e.id = i.exposure_id
         JOIN participants p ON p.id = e.participant_id
        WHERE p.room_id = ?`,
    )
    .get(roomId) as { count: number };
  return row.count;
}

export function tallies(database: QuorumDatabase, roomId: number): TallyRow[] {
  return database
    .prepare(
      `SELECT ri.id AS roomItemId, ri.slate_position AS slatePosition,
              coalesce(sum(CASE WHEN i.choice = 'RIGHT' THEN 1 ELSE 0 END), 0) AS yes,
              count(i.id) AS responses
         FROM room_items ri
         LEFT JOIN exposures e ON e.room_item_id = ri.id
         LEFT JOIN interactions i ON i.exposure_id = e.id
        WHERE ri.room_id = ?
        GROUP BY ri.id
        ORDER BY ri.slate_position`,
    )
    .all(roomId) as TallyRow[];
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
