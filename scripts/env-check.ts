/**
 * Check a .env file for mistakes before starting ATLAS: `npm run env:check [-- path/to/file]`
 *
 * Reads the file without loading it, and never prints values, so the output is safe to share when asking for help.
 * It checks the file's format only; `npm run providers:check -- --live` then tests the keys against the services.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkEnvFile, decodeEnvFile, secretsInTemplate, secretsSet, templateNames } from '../src/server/config/env-file';

const root = process.cwd();
const isWindows = process.platform === 'win32';
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const file = path.resolve(root, arg ?? '.env');
const shown = path.relative(root, file) || file;
const examplePath = path.join(root, '.env.example');
const example = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';

let exitCode = 0;
const say = (s = '') => console.log(s ? `  ${s}` : '');

console.log('');
for (const name of secretsInTemplate(example)) {
  exitCode = 1;
  say(`✖ .env.example contains a value for ${name}. That file is tracked by git: move the key to .env, then`);
  say('  restore the template with `git checkout -- .env.example`.');
}

if (!fs.existsSync(file)) {
  if (!arg && fs.existsSync(path.join(root, '.env.txt'))) {
    say('✖ Found .env.txt instead of .env (Windows added ".txt" when saving). Rename it:');
    say(isWindows ? '  Rename-Item .env.txt .env' : '  mv .env.txt .env');
  } else {
    say(`✖ No ${shown} file in ${root}.`);
    say(`  Create it from the template: ${isWindows ? 'Copy-Item .env.example .env' : 'cp .env.example .env'}`);
  }
  console.log('');
  process.exit(1);
}

const text = decodeEnvFile(fs.readFileSync(file));
if (text === null) {
  say(`✖ ${shown} is saved as UTF-16 ("Unicode"), which neither Docker nor Next.js can read.`);
  say('  Save it again as UTF-8 (Notepad: File → Save as → Encoding: UTF-8).');
  console.log('');
  process.exit(1);
}
const problems = checkEnvFile(text, templateNames(example));
const errors = problems.filter((p) => p.level === 'error').length;
const warnings = problems.length - errors;

say(`Checked ${shown}`);
say();
for (const p of problems) {
  const where = p.line ? `line ${p.line}`.padEnd(9) : ''.padEnd(9);
  say(`${p.level === 'error' ? '✖' : '⚠'} ${where} ${p.message}`);
}
if (problems.length) say();

const { set, missing } = secretsSet(text);
say(`API keys set (${set.length}): ${set.join(', ') || 'none'}`);
say(`Not set: ${missing.join(', ') || 'none'}`);
say();
if (!arg && fs.existsSync(path.join(root, '.env.local'))) {
  say('ℹ There is also a .env.local file: with npm its values take priority over .env (Docker ignores it).');
  say();
}

if (errors) {
  exitCode = 1;
  say(`✖ ${errors} problem${errors === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. Values were not printed.`);
} else if (warnings) {
  say(`⚠ No errors, ${warnings} warning${warnings === 1 ? '' : 's'} to look at. Values were not printed.`);
} else {
  say('✔ The file looks good. Values were not printed.');
}
if (!errors) {
  say();
  say('Next, restart ATLAS so it reads the file, then test each key against its service:');
  say('  npm:    npm run providers:check -- --live');
  say('  Docker: recreate the container with --env-file .env, then');
  say('          docker exec atlas npm run providers:check -- --live');
}
console.log('');
process.exit(exitCode);
