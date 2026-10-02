import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { Kysely, PostgresAdapter, PostgresDialect, SqliteDialect } from 'kysely';
import type { Database } from './schema';

export type DialectName = 'sqlite' | 'postgres';

interface DbHolder {
  db: Kysely<Database>;
  dialect: DialectName;
  url: string;
}

const globalForDb = globalThis as unknown as { __atlasDb?: DbHolder };

export function resolveDialect(url: string): DialectName {
  return /^postgres(ql)?:\/\//i.test(url) ? 'postgres' : 'sqlite';
}

function sqlitePath(url: string): string {
  if (url === ':memory:' || url === 'file::memory:') return ':memory:';
  const p = url.replace(/^file:/i, '').replace(/^sqlite:/i, '');
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), p);
}

export function createDb(url: string): DbHolder {
  const dialect = resolveDialect(url);
  if (dialect === 'postgres') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pg = require('pg') as typeof import('pg');
    // Normalise types so both dialects return identical JS shapes.
    pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString()); // timestamptz
    pg.types.setTypeParser(1114, (v: string) => new Date(v + 'Z').toISOString()); // timestamp
    pg.types.setTypeParser(20, (v: string) => Number(v)); // int8 (counts)
    pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.ATLAS_PG_POOL_MAX ?? 10) });
    return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), dialect, url };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3');
  const file = sqlitePath(url);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new BetterSqlite(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  return { db: new Kysely<Database>({ dialect: new SqliteDialect({ database }) }), dialect, url };
}

function currentUrl(): string {
  return process.env.DATABASE_URL && process.env.DATABASE_URL !== '' ? process.env.DATABASE_URL : 'file:./data/atlas.db';
}

export function getDbHolder(): DbHolder {
  const url = currentUrl();
  if (!globalForDb.__atlasDb || globalForDb.__atlasDb.url !== url) {
    globalForDb.__atlasDb = createDb(url);
  }
  return globalForDb.__atlasDb;
}

export function db(): Kysely<Database> {
  return getDbHolder().db;
}

export function dialect(): DialectName {
  return getDbHolder().dialect;
}

export function isPostgres(k: Kysely<Database>): boolean {
  return k.getExecutor().adapter instanceof PostgresAdapter;
}

/** Close and forget the shared connection (tests, scripts). */
export async function closeDb(): Promise<void> {
  const holder = globalForDb.__atlasDb;
  globalForDb.__atlasDb = undefined;
  if (holder) await holder.db.destroy();
}
