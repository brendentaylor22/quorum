import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsDirectory, openDatabase } from './index.js';
import { migrate } from './migrate.js';
import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
} from './operations.js';

describe('database operations', () => {
  it('migrates once and preserves records through verified backup and restore', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-db-'));
    const source = join(directory, 'source.db');
    const backup = join(directory, 'backup.db');
    const restored = join(directory, 'restored.db');
    const database = openDatabase(source);
    expect(migrate(database, migrationsDirectory)).toEqual([
      '0001_foundation.sql',
      '0002_room_model.sql',
      '0003_catalog_ranking.sql',
      '0004_rounds.sql',
      '0005_catalog_images.sql',
    ]);
    expect(migrate(database, migrationsDirectory)).toEqual([]);
    database
      .prepare(
        `INSERT INTO rooms (public_id, state, invite_token_hash, host_token_hash, created_at, expires_at)
         VALUES (?, 'LOBBY', ?, ?, ?, ?)`,
      )
      .run(
        'room-public-id',
        'invite-hash',
        'host-hash',
        '2026-08-11T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z',
      );
    database.close();

    expect((await backupDatabase(source, backup)).counts.rooms).toBe(1);
    chmodSync(backup, 0o444);
    expect((await restoreDatabase(backup, restored)).counts).toEqual(
      inspectDatabase(source).counts,
    );
    expect(existsSync(restored)).toBe(true);
  });

  it('refuses overwrite destinations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-db-'));
    const source = join(directory, 'source.db');
    const database = openDatabase(source);
    migrate(database, migrationsDirectory);
    database.close();

    await expect(backupDatabase(source, source)).rejects.toThrow('new path');
    await expect(restoreDatabase(source, source)).rejects.toThrow(
      'must not exist',
    );
  });
});
