import { publicRoute, jsonResponse } from '@/server/api/handler';
import { db, dialect } from '@/server/db/client';
import { workerStatus } from '@/server/engine/bootstrap';
import { sql } from 'kysely';
import { aboutInfo } from '@/server/config/about';

export const dynamic = 'force-dynamic';

export const GET = publicRoute(async () => {
  let database = 'ok';
  try {
    await sql`SELECT 1`.execute(db());
  } catch {
    database = 'error';
  }
  const { version } = aboutInfo();
  return jsonResponse({ status: database === 'ok' ? 'ok' : 'degraded', version, database, dialect: dialect(), worker: workerStatus(), time: new Date().toISOString() }, { status: database === 'ok' ? 200 : 503 });
});
