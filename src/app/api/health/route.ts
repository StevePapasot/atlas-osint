import { publicRoute, jsonResponse } from '@/server/api/handler';
import { db, dialect } from '@/server/db/client';
import { workerStatus } from '@/server/engine/bootstrap';
import { sql } from 'kysely';

export const dynamic = 'force-dynamic';

export const GET = publicRoute(async () => {
  let database = 'ok';
  try {
    await sql`SELECT 1`.execute(db());
  } catch {
    database = 'error';
  }
  return jsonResponse({ status: database === 'ok' ? 'ok' : 'degraded', database, dialect: dialect(), worker: workerStatus(), time: new Date().toISOString() }, { status: database === 'ok' ? 200 : 503 });
});
