import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { db } from '@/server/db/client';
import { setupDb, makeUser } from '../helpers/db';

// Runs only against PostgreSQL (TEST_DATABASE_URL). Simulates Supabase's API roles locally.
const pg = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(pg)('supabase/rls.sql hardening', () => {
  beforeAll(async () => {
    await setupDb();
    await makeUser('RLS');
    for (const role of ['anon', 'authenticated']) {
      await sql.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$;`).execute(db());
      // Mimic Supabase's default grants, which the script must take away again.
      await sql.raw(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};`).execute(db());
    }
    await sql.raw(fs.readFileSync(path.join(process.cwd(), 'supabase/rls.sql'), 'utf8')).execute(db());
  });

  it('enables RLS on every ATLAS table', async () => {
    const r = await sql<{ relname: string; relrowsecurity: boolean }>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`.execute(db());
    expect(r.rows.length).toBeGreaterThan(20);
    expect(r.rows.filter((x) => !x.relrowsecurity).map((x) => x.relname)).toEqual([]);
  });

  it('denies the Supabase API roles while the server role keeps working', async () => {
    await db().connection().execute(async (conn) => {
      for (const role of ['anon', 'authenticated']) {
        await sql.raw(`SET ROLE ${role}`).execute(conn);
        await expect(sql`SELECT email FROM users`.execute(conn)).rejects.toThrow(/permission denied/);
        await sql.raw('RESET ROLE').execute(conn);
      }
    });
    const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM users`.execute(db());
    expect(Number(r.rows[0]!.n)).toBe(1);
  });

  it('is idempotent', async () => {
    await sql.raw(fs.readFileSync(path.join(process.cwd(), 'supabase/rls.sql'), 'utf8')).execute(db());
  });
});
