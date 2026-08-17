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
    applyMigration(database, basename(name), sql);
  }

  return pending;
}

/**
 * Apply one migration with foreign keys disabled.
 *
 * SQLite cannot alter a constraint in place, so evolving a referenced table
 * means rebuilding it: create, copy preserving row ids, drop, rename. Dropping
 * the old table trips foreign key enforcement even though the result is
 * consistent, and the pragma is a no-op inside a transaction — so it has to be
 * toggled outside one. This is the procedure SQLite documents.
 *
 * `foreign_key_check` afterwards is what keeps that safe: a migration that
 * genuinely orphans a row fails and rolls back rather than quietly landing.
 */
function applyMigration(
  database: QuorumDatabase,
  name: string,
  sql: string,
): void {
  const enforced =
    (database.pragma('foreign_keys', { simple: true }) as
      number | undefined) === 1;
  if (enforced) database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(sql);
      const violations = database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Migration ${name} left ${violations.length.toString()} foreign key violations`,
        );
      }
      database
        .prepare(
          'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
        )
        .run(name, new Date().toISOString());
    })();
  } finally {
    if (enforced) database.pragma('foreign_keys = ON');
  }
}
