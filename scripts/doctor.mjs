// Checks that this machine can run ATLAS: a supported Node.js version and a complete node_modules folder.
//
//   npm run doctor           full check, always
//   (automatic)              before `npm run setup` (full) and before `npm run dev` / `npm start` (full check only
//                            when the installed packages or the Node.js version changed since the last good check)
//
// Plain JavaScript on purpose: it has to work when dependencies are broken.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const MIN_NODE = '22.19.0'; // keep in sync with src/server/config/runtime.ts
// Packages that only run in a browser (they touch `window` when loaded) or contain no JavaScript.
const SKIP = new Set(['leaflet', 'react-leaflet']);
const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

const root = process.cwd();
const nodeModules = path.join(root, 'node_modules');
const stampFile = path.join(nodeModules, '.atlas-doctor-ok');
const full = process.argv.includes('--full');
const isWindows = process.platform === 'win32';

function fail(title, lines) {
  console.error(`\n  ✖ ${title}\n`);
  for (const l of lines) console.error(l ? `    ${l}` : '');
  console.error('');
  process.exit(1);
}

// ------------------------------------------------------------------ 1. Node.js version
const parts = (v) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
const older = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
if (older(process.versions.node, MIN_NODE)) {
  fail(`ATLAS needs Node.js ${MIN_NODE} or newer, but this is Node.js ${process.versions.node}.`, [
    'Older Node 22 releases make the SQLite driver crash without any error message.',
    'Install the current LTS from https://nodejs.org (or `nvm install lts` if you use nvm),',
    'close and reopen the terminal, check `node -v`, and run the command again.',
  ]);
}

// ------------------------------------------------------------------ 2. Installed at all?
if (!fs.existsSync(path.join(nodeModules, '.package-lock.json')) && !fs.existsSync(path.join(nodeModules, 'next'))) {
  fail('Dependencies are not installed.', ['Run `npm install` in this folder first.']);
}

// Skip the (slower) package check when nothing changed since the last successful one.
const fingerprint = createHash('sha256')
  .update(process.versions.node)
  .update(fs.existsSync(path.join(nodeModules, '.package-lock.json')) ? fs.readFileSync(path.join(nodeModules, '.package-lock.json')) : '')
  .update(fs.existsSync(path.join(root, 'package-lock.json')) ? fs.readFileSync(path.join(root, 'package-lock.json')) : '')
  .digest('hex');
if (!full && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === fingerprint) process.exit(0);

// ------------------------------------------------------------------ 3. Every dependency loads (with what it imports)
// Loading a package also loads the files it imports, so files missing anywhere in its tree show up as "not found".
const problems = [];
const ignoreAsync = (err) => {
  // Browser-oriented code can throw later from timers; only missing files matter here.
  if (NOT_FOUND.has(err?.code)) problems.push(String(err.message).split('\n')[0]);
};
process.on('uncaughtException', ignoreAsync);
process.on('unhandledRejection', ignoreAsync);

const requireFromRoot = createRequire(path.join(root, 'package.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const dir = path.join(nodeModules, ...dep.split('/'));
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    problems.push(`${dep} is not installed`);
    continue;
  }
  if (SKIP.has(dep)) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!manifest.main && !manifest.exports && !manifest.module && !fs.existsSync(path.join(dir, 'index.js'))) continue; // data/asset package
  // Load the ES-module build (what Next.js bundles) and, when it is a separate file, the CommonJS build (what
  // server-external packages and scripts use).
  const entries = new Set();
  try {
    entries.add(import.meta.resolve(dep, pathToFileURL(path.join(root, 'package.json')).href));
  } catch (err) {
    if (NOT_FOUND.has(err?.code)) problems.push(`${dep}: ${String(err.message).split('\n')[0]}`);
  }
  try {
    entries.add(pathToFileURL(requireFromRoot.resolve(dep)).href);
  } catch {
    /* ESM-only package */
  }
  for (const url of entries) {
    if (!/\.(c|m)?js$/.test(url)) continue; // CSS, JSON or other assets
    try {
      await import(url);
    } catch (err) {
      if (NOT_FOUND.has(err?.code)) problems.push(`${dep}: ${String(err.message).split('\n')[0]}`);
    }
  }
}

// ------------------------------------------------------------------ 4. Native modules work
try {
  const { default: Database } = await import(pathToFileURL(requireFromRoot.resolve('better-sqlite3')).href);
  new Database(':memory:').prepare('select 1').get();
} catch (err) {
  problems.push(`better-sqlite3 cannot open a database: ${String(err?.message ?? err).split('\n')[0]}`);
}

if (problems.length) {
  const short = (m) => m.split(pathToFileURL(root).href + '/').join('').split(root + path.sep).join('').split(root + '/').join('');
  const unique = [...new Set(problems.map(short))];
  fail('Your node_modules folder is incomplete — some installed files are missing:', [
    ...unique.slice(0, 6).map((p) => `• ${p}`),
    ...(unique.length > 6 ? [`• …and ${unique.length - 6} more`] : []),
    '',
    'This happens when an install was interrupted, or when files were removed after installing',
    '(on Windows this is usually antivirus software). Reinstall from scratch:',
    '',
    isWindows ? '  Remove-Item -Recurse -Force node_modules, .next' : '  rm -rf node_modules .next',
    '  npm cache verify',
    '  npm install',
    '',
    'If this message comes back, look in your antivirus quarantine / protection history for files from',
    `${nodeModules}, restore or allow them (or exclude this project folder), then reinstall.`,
  ]);
}

fs.writeFileSync(stampFile, fingerprint);
if (full) console.log(`  ✔ Node.js ${process.versions.node} — dependencies complete, database driver working.`);
process.exit(0);
