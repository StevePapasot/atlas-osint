import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Every test file gets its own data directory and its own database: a fresh SQLite file by default, or — when
// TEST_DATABASE_URL points at PostgreSQL — a freshly created database on that server.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
process.env.ATLAS_DATA_DIR = dir;
process.env.ATLAS_DEMO_FAST = 'true';
process.env.ATLAS_LOG_LEVEL = process.env.ATLAS_LOG_LEVEL ?? 'error';
process.env.ATLAS_DISABLE_RATE_LIMIT = process.env.ATLAS_DISABLE_RATE_LIMIT ?? 'true';

const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl && /^postgres(ql)?:\/\//i.test(pgUrl)) {
  const { default: pg } = await import('pg');
  const name = `atlas_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
} else {
  process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
}
