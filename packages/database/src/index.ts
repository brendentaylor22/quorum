import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type QuorumDatabase = DatabaseType;

export const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

export function databasePath(): string {
  return process.env.QUORUM_DATABASE_PATH ?? '/data/quorum.db';
}

export function openDatabase(path = databasePath()): QuorumDatabase {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const database = new Database(path);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return database;
}

export function integrityCheck(database: QuorumDatabase): string[] {
  const rows = database.pragma('integrity_check') as {
    integrity_check: string;
  }[];
  return rows.map((row) => row.integrity_check);
}

export function recordCounts(database: QuorumDatabase): Record<string, number> {
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];

  return Object.fromEntries(
    tables.map(({ name }) => {
      if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
        throw new Error(`Unsafe table name in schema: ${name}`);
      }
      const row = database
        .prepare(`SELECT count(*) AS count FROM "${name}"`)
        .get() as {
        count: number;
      };
      return [name, row.count];
    }),
  );
}

export { migrate } from './migrate.js';
export {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
  type DatabaseReport,
} from './operations.js';
