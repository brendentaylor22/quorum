import { loadFixtureCatalog } from '@quorum/catalog';
import {
  backupDatabase,
  databasePath,
  inspectDatabase,
  migrate,
  migrationsDirectory,
  openDatabase,
  restoreDatabase,
} from '@quorum/database';
import { importCatalog } from './rooms/repository.js';

function usage(): never {
  throw new Error(
    'Usage: quorumctl migrate | import-catalog | doctor [db] | backup <new-path> | restore <backup> <new-db-path>',
  );
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
    case 'doctor': {
      const database = openDatabase(first ?? path);
      try {
        migrate(database, migrationsDirectory);
      } finally {
        database.close();
      }
      const report = inspectDatabase(first ?? path);
      if (report.integrity.some((value) => value !== 'ok'))
        process.exitCode = 1;
      console.log(JSON.stringify(report));
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
