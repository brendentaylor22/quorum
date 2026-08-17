import { loadFixtureCatalog } from '@quorum/catalog';
import {
  backupDatabase,
  databasePath,
  inspectDatabase,
  migrate,
  migrationsDirectory,
  openDatabase,
  restoreDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import { TmdbClient } from '@quorum/tmdb';
import {
  importOptionsFromEnvironment,
  readTmdbToken,
  tmdbBaseUrl,
} from './catalog/config.js';
import { importTmdbCatalog } from './catalog/importer.js';
import {
  TMDB_CACHE_MAX_DAYS,
  catalogAgeDays,
  catalogStatus,
} from './catalog/repository.js';
import { importCatalog } from './rooms/repository.js';
import { RoomService } from './rooms/service.js';
import { resolveTokenSecret } from './capabilities.js';

function usage(): never {
  throw new Error(
    'Usage: quorumctl migrate | import-catalog | catalog-refresh | catalog-status' +
      ' | doctor [db] | backup <new-path> | restore <backup> <new-db-path>' +
      ' | purge [--room <roomId>]',
  );
}

/**
 * Apply the retention policy now, or delete one named room.
 *
 * The scheduled sweep inside the server does the same work on a timer; this
 * exists for the two cases a timer cannot answer: an operator responding to a
 * deletion request, and an operator who wants to see retention happen rather
 * than trust that it did. Deleting a single room requires naming it, because a
 * destructive command should never have a convenient no-argument form.
 */
function purge(path: string, roomId: string | undefined) {
  const database = openDatabase(path);
  try {
    migrate(database, migrationsDirectory);
    const service = new RoomService({
      database,
      secret: resolveTokenSecret(path),
    });
    if (roomId !== undefined) {
      const deleted = service.purgeRoom(roomId);
      return { room: roomId, deleted, counts: service.retentionCounts() };
    }
    const result = service.applyRetention();
    return { ...result, counts: service.retentionCounts() };
  } finally {
    database.close();
  }
}

/**
 * Refresh the catalog from TMDB. This is the only command that reaches the
 * Internet, which is why it runs as its own container on its own network
 * rather than inside the serving application.
 */
async function catalogRefresh(path: string): Promise<void> {
  const token = readTmdbToken();
  const options = importOptionsFromEnvironment();
  const database = openDatabase(path);
  try {
    migrate(database, migrationsDirectory);
    const baseUrl = tmdbBaseUrl();
    const client = new TmdbClient({
      token,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      onRetry: (info) => {
        console.error(
          `retry ${info.attempt.toString()} ${info.path}: ${info.reason}`,
        );
      },
    });
    const report = await importTmdbCatalog(database, client, {
      ...options,
      onProgress: (progress) => {
        console.error(
          `${progress.phase} discovered=${progress.discovered.toString()}` +
            ` accepted=${progress.accepted.toString()}` +
            ` rejected=${progress.rejected.toString()}` +
            ` failed=${progress.failed.toString()}`,
        );
      },
    });
    console.log(JSON.stringify(report));
  } finally {
    database.close();
  }
}

/**
 * Catalog health, including the provider cache limit. Content older than the
 * limit must be refreshed or purged, so it is reported as a hard condition.
 */
function catalogReport(database: QuorumDatabase) {
  const status = catalogStatus(database);
  const ageDays = catalogAgeDays(database, new Date());
  return {
    ...status,
    ageDays,
    cacheLimitDays: TMDB_CACHE_MAX_DAYS,
    overCacheLimit: ageDays !== null && ageDays > TMDB_CACHE_MAX_DAYS,
  };
}

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  const path = databasePath();
  switch (command) {
    case 'migrate': {
      const database = openDatabase(path);
      try {
        console.log(
          JSON.stringify({ applied: migrate(database, migrationsDirectory) }),
        );
      } finally {
        database.close();
      }
      break;
    }
    case 'import-catalog': {
      const database = openDatabase(path);
      try {
        migrate(database, migrationsDirectory);
        const imported = importCatalog(
          database,
          loadFixtureCatalog(),
          new Date().toISOString(),
        );
        console.log(JSON.stringify({ imported }));
      } finally {
        database.close();
      }
      break;
    }
    case 'catalog-refresh':
      await catalogRefresh(path);
      break;
    case 'catalog-status': {
      const database = openDatabase(first ?? path);
      try {
        migrate(database, migrationsDirectory);
        const report = catalogReport(database);
        console.log(JSON.stringify(report));
        // Both an empty catalog and one past the provider's cache limit are
        // failures an operator has to act on, not warnings to scroll past.
        if (report.activeItems === 0 || report.overCacheLimit) {
          process.exitCode = 1;
        }
      } finally {
        database.close();
      }
      break;
    }
    case 'doctor': {
      const database = openDatabase(first ?? path);
      let catalog;
      try {
        migrate(database, migrationsDirectory);
        catalog = catalogReport(database);
      } finally {
        database.close();
      }
      const report = inspectDatabase(first ?? path);
      if (report.integrity.some((value) => value !== 'ok'))
        process.exitCode = 1;
      console.log(JSON.stringify({ ...report, catalog }));
      break;
    }
    case 'purge': {
      if (first !== undefined && first !== '--room') usage();
      if (first === '--room' && second === undefined) usage();
      const report = purge(path, first === '--room' ? second : undefined);
      console.log(JSON.stringify(report));
      // Naming a room that is not there is a failed instruction, not a no-op:
      // an operator answering a deletion request needs to know the difference.
      if ('deleted' in report && !report.deleted) process.exitCode = 1;
      break;
    }
    case 'backup':
      if (first === undefined) usage();
      console.log(JSON.stringify(await backupDatabase(path, first)));
      break;
    case 'restore':
      if (first === undefined || second === undefined) usage();
      console.log(JSON.stringify(await restoreDatabase(first, second)));
      break;
    default:
      usage();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
