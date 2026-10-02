import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every test file gets its own data directory and SQLite database unless TEST_DATABASE_URL points at PostgreSQL.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
process.env.ATLAS_DATA_DIR = dir;
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || `file:${path.join(dir, 'test.db')}`;
process.env.ATLAS_DEMO_FAST = 'true';
process.env.ATLAS_LOG_LEVEL = process.env.ATLAS_LOG_LEVEL ?? 'error';
process.env.ATLAS_DISABLE_RATE_LIMIT = process.env.ATLAS_DISABLE_RATE_LIMIT ?? 'true';
