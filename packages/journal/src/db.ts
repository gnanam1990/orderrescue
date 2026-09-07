import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/**
 * WAL plus a real busy timeout is what lets a reconciliation worker read while
 * an API request holds a write transaction, instead of the worker failing with
 * SQLITE_BUSY and leaving an UNKNOWN operation unattended.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL'); // an intent must survive power loss, not just process exit
  migrate(db);
  return db;
}

function loadSchemaSql(): string {
  // Resolves whether running from src (tsx/vitest) or dist (built server).
  for (const candidate of [join(here, 'schema.sql'), join(here, '..', 'src', 'schema.sql')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error('journal: schema.sql not found next to the module');
}

export const SCHEMA_VERSION = 1;

export function migrate(db: Db): void {
  db.exec(loadSchemaSql());
  const current = db
    .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get();
  if (current === undefined) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    return;
  }
  const found = Number(current.value);
  if (found !== SCHEMA_VERSION) {
    throw new Error(
      `journal: database is at schema version ${found} but this build expects ${SCHEMA_VERSION}`,
    );
  }
}

/**
 * BEGIN IMMEDIATE, not the default deferred BEGIN: a transaction that will
 * write takes the write lock up front, so two concurrent execute requests
 * serialize at the start instead of one discovering a conflict after it has
 * already decided to dispatch.
 */
export function inWriteTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rollback of an already-aborted transaction is not itself an error
    }
    throw error;
  }
}
