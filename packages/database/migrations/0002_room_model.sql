-- Phase 2 room model. Replaces the Phase 1 placeholder table with the
-- section 4 schema: catalog, rooms, participants, slate, exposures,
-- interactions, and audit events.

DROP TABLE IF EXISTS foundation_records;

CREATE TABLE catalog_items (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('MOVIE')),
  title TEXT NOT NULL,
  release_year INTEGER,
  synopsis TEXT,
  runtime_minutes INTEGER,
  content_rating TEXT,
  language TEXT,
  image_ref TEXT,
  catalog_version TEXT NOT NULL,
  source_fetched_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (provider, provider_ref)
) STRICT;

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('LOBBY', 'VOTING', 'COMPLETE', 'EXPIRED')),
  invite_token_hash TEXT NOT NULL UNIQUE,
  host_token_hash TEXT NOT NULL UNIQUE,
  catalog_version TEXT,
  slate_seed TEXT,
  eligible_count INTEGER,
  closed_early INTEGER NOT NULL DEFAULT 0 CHECK (closed_early IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX rooms_expires_at ON rooms (expires_at);

CREATE TABLE participants (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE INDEX participants_room ON participants (room_id);

CREATE TABLE room_items (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL REFERENCES catalog_items (id),
  slate_position INTEGER NOT NULL,
  UNIQUE (room_id, slate_position),
  UNIQUE (room_id, catalog_item_id)
) STRICT;

CREATE TABLE exposures (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
  room_item_id INTEGER NOT NULL REFERENCES room_items (id) ON DELETE CASCADE,
  context TEXT NOT NULL CHECK (context IN ('WATCH_NOW')),
  shown_at TEXT NOT NULL,
  slate_version TEXT NOT NULL,
  UNIQUE (participant_id, room_item_id)
) STRICT;

CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  exposure_id INTEGER NOT NULL UNIQUE REFERENCES exposures (id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK (choice IN ('LEFT', 'RIGHT')),
  confirmed_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  room_id INTEGER REFERENCES rooms (id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_room ON audit_events (room_id);
