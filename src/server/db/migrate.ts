import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import * as m001 from './migrations/001_initial';
import type { Database } from './schema';

/** Migrations are registered in code so they work identically when bundled by Next.js or run via tsx. */
const MIGRATIONS: Record<string, Migration> = {
  '001_initial': m001,
};

class StaticProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<{ applied: string[] }> {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    const reason = error instanceof Error ? error.message : String(error ?? failed?.migrationName);
    throw new Error(`Database migration failed: ${reason}`);
  }
  return { applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName) };
}

export async function migrationStatus(db: Kysely<Database>) {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  return migrator.getMigrations();
}
