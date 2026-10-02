import { describe, expect, it } from 'vitest';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { sql } from 'kysely';
import { db, dialect } from '@/server/db/client';
import { migrateToLatest, migrationStatus } from '@/server/db/migrate';
import * as m001 from '@/server/db/migrations/001_initial';

class Provider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { '001_initial': m001 };
  }
}

async function tableNames(): Promise<string[]> {
  const tables = await db().introspection.getTables();
  return tables.map((t) => t.name).filter((n) => !n.startsWith('kysely_'));
}

const REQUIRED = [
  'users', 'sessions', 'investigations', 'targets', 'investigation_jobs', 'job_tasks', 'sources', 'observations',
  'evidence', 'findings', 'entities', 'relationships', 'relationship_evidence', 'entity_match_candidates',
  'timeline_events', 'artifacts', 'analyst_notes', 'tags', 'reports', 'ai_analyses', 'audit_events',
  'provider_configurations', 'provider_health', 'finding_reviews',
];

describe(`migrations (${process.env.TEST_DATABASE_URL ? 'postgres' : 'sqlite'})`, () => {
  it('applies cleanly to an empty database and is idempotent', async () => {
    const first = await migrateToLatest(db());
    expect(first.applied).toEqual(['001_initial']);
    const second = await migrateToLatest(db());
    expect(second.applied).toEqual([]);
    const names = await tableNames();
    for (const t of REQUIRED) expect(names, t).toContain(t);
    const status = await migrationStatus(db());
    expect(status.every((m) => m.executedAt)).toBe(true);
  });

  it('enforces constraints at the database level', async () => {
    const now = new Date().toISOString();
    const insertUser = (email: string) =>
      db().insertInto('users').values({ id: crypto.randomUUID(), email, name: 'x', password_hash: 'x', role: 'analyst', preferences: '{}', created_at: now, updated_at: now, last_login_at: null }).execute();
    await insertUser('dup@atlas.test');
    await expect(insertUser('dup@atlas.test')).rejects.toThrow();
    // Foreign keys: an investigation cannot reference a missing owner.
    await expect(
      db().insertInto('investigations').values({ id: crypto.randomUUID(), owner_id: crypto.randomUUID(), name: 'orphan', description: null, scope_statement: null, status: 'draft', depth: 'quick', mode: 'demo', modules: '[]', providers: '[]', created_at: now, updated_at: now, started_at: null, completed_at: null, retention_until: null }).execute(),
    ).rejects.toThrow();
    expect(dialect()).toBe(process.env.TEST_DATABASE_URL ? 'postgres' : 'sqlite');
  });

  it('rolls back completely and re-applies', async () => {
    const migrator = new Migrator({ db: db(), provider: new Provider() });
    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(await tableNames()).toEqual([]);
    const up = await migrateToLatest(db());
    expect(up.applied).toEqual(['001_initial']);
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`.execute(db());
    expect(Number(r.rows[0]!.n)).toBe(0);
  });
});
