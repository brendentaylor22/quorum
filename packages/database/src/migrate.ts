import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { QuorumDatabase } from './index.js';

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

export function migrate(database: QuorumDatabase, directory: string): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (
      database.prepare('SELECT name FROM schema_migrations').all() as {
        name: string;
      }[]
    ).map(({ name }) => name),
  );
  const files = readdirSync(directory)
    .filter((name) => migrationPattern.test(name))
    .sort();
  const pending = files.filter((name) => !applied.has(name));

  for (const name of pending) {
    const sql = readFileSync(join(directory, name), 'utf8');
    database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
        )
        .run(basename(name), new Date().toISOString());
    })();
  }

  return pending;
}
