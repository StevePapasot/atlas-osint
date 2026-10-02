// Starts the production server for Playwright with a fresh, isolated database.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] ?? '3100';
const dataDir = path.resolve('data/e2e');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync('.next/BUILD_ID')) {
  console.error('No production build found. Run `npm run build` before `npm run test:e2e`.');
  process.exit(1);
}

const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', port, '-H', '127.0.0.1'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: `file:${path.join(dataDir, 'atlas-e2e.db')}`,
    ATLAS_DATA_DIR: dataDir,
    ATLAS_DEMO_FAST: 'true',
    ATLAS_ALLOW_REGISTRATION: 'true',
    ATLAS_COOKIE_SECURE: 'false',
    ATLAS_APP_URL: `http://127.0.0.1:${port}`,
    ATLAS_LOG_LEVEL: process.env.ATLAS_LOG_LEVEL ?? 'error',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
