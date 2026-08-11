import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { integrityCheck, openDatabase, recordCounts } from './index.js';

export interface DatabaseReport {
  path: string;
  integrity: string[];
  counts: Record<string, number>;
}

function reportDatabase(
  path: string,
  database: Database.Database,
): DatabaseReport {
  return {
    path,
    integrity: integrityCheck(database),
    counts: recordCounts(database),
  };
}

function requireRegularFile(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Expected regular SQLite file: ${path}`);
  }
}

export function inspectDatabase(path: string): DatabaseReport {
  requireRegularFile(path);
  const database = openDatabase(path);
  try {
    return reportDatabase(path, database);
  } finally {
    database.close();
  }
}

function inspectBackup(path: string): DatabaseReport {
  requireRegularFile(path);
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    return reportDatabase(path, database);
  } finally {
    database.close();
  }
}

export async function backupDatabase(
  source: string,
  destination: string,
): Promise<DatabaseReport> {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath || existsSync(destinationPath)) {
    throw new Error(
      'Backup destination must be a new path distinct from source',
    );
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const database = openDatabase(sourcePath);
  let sourceReport: DatabaseReport;
  try {
    await database.backup(destinationPath);
    sourceReport = reportDatabase(sourcePath, database);
  } finally {
    database.close();
  }
  const portableBackup = new Database(destinationPath, { fileMustExist: true });
  try {
    portableBackup.pragma('journal_mode = DELETE');
  } finally {
    portableBackup.close();
  }
  const backupReport = inspectBackup(destinationPath);
  if (
    backupReport.integrity.some((value) => value !== 'ok') ||
    JSON.stringify(sourceReport.counts) !== JSON.stringify(backupReport.counts)
  ) {
    rmSync(destinationPath, { force: true });
    throw new Error(
      'Backup verification failed: integrity or record counts differ',
    );
  }
  return backupReport;
}

export async function restoreDatabase(
  source: string,
  destination: string,
): Promise<DatabaseReport> {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  requireRegularFile(sourcePath);
  if (sourcePath === destinationPath || existsSync(destinationPath)) {
    throw new Error(
      'Restore destination must not exist and must differ from backup',
    );
  }
  const sourceReport = inspectBackup(sourcePath);
  if (sourceReport.integrity.some((value) => value !== 'ok')) {
    throw new Error('Backup integrity check failed');
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.restore-${process.pid.toString()}`;
  const backup = new Database(sourcePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    await backup.backup(temporaryPath);
  } finally {
    backup.close();
  }
  renameSync(temporaryPath, destinationPath);
  const restored = inspectDatabase(destinationPath);
  if (JSON.stringify(sourceReport.counts) !== JSON.stringify(restored.counts)) {
    rmSync(destinationPath, { force: true });
    throw new Error('Restored record counts differ from backup');
  }
  return restored;
}
