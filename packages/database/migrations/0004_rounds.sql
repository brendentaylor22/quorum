-- Multi-round rooms. A room's first slate is 20 drawn from the top-rated
-- pool; after results, the group may keep voting on a further 20 chosen from
-- what they collectively liked.
--
-- Everything that was previously per-room and slate-shaped moves to the round:
-- the seed, the catalog version, the frozen participant count, and completion.
-- The room keeps its lifecycle state; a round carries one slate.

CREATE TABLE rounds (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  slate_seed TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  -- How the slate was chosen. Persisted so a slate can be explained and
  -- replayed, and so a scoring change is visible rather than silent.
  strategy TEXT NOT NULL CHECK (strategy IN ('TOP_RATED', 'RECOMMENDED')),
  algorithm_version TEXT,
  -- Frozen at round start: the denominator for this round's percentages.
  eligible_count INTEGER NOT NULL CHECK (eligible_count >= 1),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  closed_early INTEGER NOT NULL DEFAULT 0 CHECK (closed_early IN (0, 1)),
  UNIQUE (room_id, round_number)
) STRICT;

CREATE INDEX rounds_room ON rounds (room_id);

-- Rebuild room_items so a slate position is unique per round rather than per
-- room, while a catalog item stays unique per room: a later round must never
-- re-show a movie the group has already judged.
CREATE TABLE room_items_new (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items (id),
  slate_position INTEGER NOT NULL,
  -- Why this item was chosen, for later rounds. Null for a top-rated slate.
  reason TEXT,
  UNIQUE (round_id, slate_position),
  UNIQUE (room_id, catalog_item_id)
) STRICT;

-- Adopt every existing room's slate as its round 1. Rooms that never started
-- have no slate and so need no round.
INSERT INTO rounds (
  room_id, round_number, slate_seed, catalog_version, strategy,
  eligible_count, started_at, completed_at, closed_early
)
SELECT r.id, 1,
       coalesce(r.slate_seed, 'legacy'),
       coalesce(r.catalog_version, 'legacy'),
       'TOP_RATED',
       coalesce(r.eligible_count, 1),
       coalesce(r.started_at, r.created_at),
       r.completed_at,
       r.closed_early
  FROM rooms r
 WHERE EXISTS (SELECT 1 FROM room_items ri WHERE ri.room_id = r.id);

INSERT INTO room_items_new (id, room_id, round_id, catalog_item_id, slate_position)
SELECT ri.id, ri.room_id, rd.id, ri.catalog_item_id, ri.slate_position
  FROM room_items ri
  JOIN rounds rd ON rd.room_id = ri.room_id AND rd.round_number = 1;

DROP TABLE room_items;
ALTER TABLE room_items_new RENAME TO room_items;

CREATE INDEX room_items_round ON room_items (round_id);
CREATE INDEX room_items_room ON room_items (room_id);
