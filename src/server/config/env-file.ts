import 'server-only';
import { ENV_KEYS, SECRET_KEYS, type SecretKey, validateEnvValues } from './env';

/**
 * Static checks of a .env file for `npm run env:check`: syntax that Docker's `--env-file` and Next.js read
 * differently, placeholders, keys pasted into the wrong line, typos in names and values the app would refuse.
 * Reports never contain values, so they are safe to share.
 */

export interface EnvFileProblem {
  level: 'error' | 'warning';
  line?: number;
  name?: string;
  message: string;
}

export interface EnvEntry {
  line: number;
  name: string;
  /** Value as written after `=`, untrimmed (null when the line has no `=`). */
  raw: string | null;
}

/** Variables used by tooling, Node.js or the Docker setup rather than the configuration schema. */
const OTHER_KNOWN = [
  'NODE_ENV',
  'PORT',
  'HOSTNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'ATLAS_IMAGE',
  'TEST_DATABASE_URL',
  'E2E_BASE_URL',
  'PLAYWRIGHT_CHROMIUM_PATH',
];

/** Only formats documented by the services; anything else is checked for whitespace, quotes and placeholders. */
const KEY_FORMATS: Partial<Record<SecretKey, { test: RegExp; hint: string }>> = {
  BRAVE_SEARCH_API_KEY: { test: /^BSA[\w-]{10,}$/, hint: 'Brave Search API keys start with "BSA"' },
  GITHUB_TOKEN_OSINT: {
    test: /^(ghp_[A-Za-z0-9]{36}|github_pat_\w{20,}|[a-f0-9]{40})$/,
    hint: 'GitHub tokens start with "ghp_" or "github_pat_"',
  },
  YOUTUBE_API_KEY: { test: /^AIza[\w-]{35}$/, hint: 'Google API keys start with "AIza" and are 39 characters long' },
  VIRUSTOTAL_API_KEY: { test: /^[a-f0-9]{64}$/i, hint: 'VirusTotal API keys are 64 hexadecimal characters' },
  SHODAN_API_KEY: { test: /^[A-Za-z0-9]{32}$/, hint: 'Shodan API keys are 32 letters and digits' },
  ETHERSCAN_API_KEY: { test: /^[A-Za-z0-9]{34}$/, hint: 'Etherscan API keys are 34 letters and digits' },
  HIBP_API_KEY: { test: /^[a-f0-9]{32}$/i, hint: 'Have I Been Pwned API keys are 32 hexadecimal characters' },
  INTELX_API_KEY: {
    test: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    hint: 'Intelligence X API keys look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  ANTHROPIC_API_KEY: { test: /^sk-ant-[\w-]{20,}$/, hint: 'Anthropic API keys start with "sk-ant-"' },
};

const PLACEHOLDER = /^(<.*>|\[.*\]|\.{3,}|x{4,}|change-?me|todo|none|null|undefined|your[\s_-].*|paste[\s_-].*|.*[\s_-]here)$/i;
const SECRETS = new Set<string>(SECRET_KEYS);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split a .env text into assignments (comments and blank lines skipped). Accepts LF and CRLF line endings. */
export function parseEnvLines(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  text.split(/\r?\n/).forEach((content, i) => {
    const trimmed = content.trimStart();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    entries.push(
      eq === -1 ? { line: i + 1, name: trimmed.trimEnd(), raw: null } : { line: i + 1, name: trimmed.slice(0, eq), raw: trimmed.slice(eq + 1) },
    );
  });
  return entries;
}

/** Variable names mentioned in a template such as .env.example, including commented-out ones. */
export function templateNames(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

function unquote(value: string): string {
  return /^(["'`]).*\1$/.test(value) && value.length >= 2 ? value.slice(1, -1) : value;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

function suggest(name: string, known: string[]): string | undefined {
  const upper = name.toUpperCase();
  const exact = known.find((k) => k === upper);
  if (exact) return exact;
  let best: { name: string; distance: number } | undefined;
  for (const k of known) {
    const d = levenshtein(upper, k);
    if (d <= Math.max(2, Math.floor(k.length / 5)) && (!best || d < best.distance)) best = { name: k, distance: d };
  }
  if (best) return best.name;
  // BRAVE_API_KEY → BRAVE_SEARCH_API_KEY: every part of the name appears in a known name.
  const parts = upper.split('_').filter(Boolean);
  return known
    .filter((k) => parts.length > 1 && parts.every((p) => k.split('_').includes(p)))
    .sort((x, y) => x.length - y.length)[0];
}

/** Decode a .env file, or return null when it is saved as UTF-16 ("Unicode"), which Docker and Next.js cannot read. */
export function decodeEnvFile(bytes: Uint8Array): string | null {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  return utf16 || bytes.includes(0) ? null : Buffer.from(bytes).toString('utf8');
}

/**
 * Check the contents of a .env file. `knownFromTemplate` are the variables documented in .env.example; together with
 * the configuration schema they define which names are known.
 */
export function checkEnvFile(text: string, knownFromTemplate: Iterable<string> = []): EnvFileProblem[] {
  const problems: EnvFileProblem[] = [];
  if (text.startsWith('﻿')) {
    text = text.slice(1);
    const first = text.split(/\r?\n/).find((l) => l.trim());
    if (first && !first.trimStart().startsWith('#')) {
      problems.push({
        level: 'warning',
        line: 1,
        message: 'The file starts with a byte-order mark, which Docker reads as part of the first name. Save it as "UTF-8" (not "UTF-8 with BOM").',
      });
    }
  }

  const known = [...new Set([...ENV_KEYS, ...OTHER_KNOWN, ...knownFromTemplate])];
  const firstLine = new Map<string, number>();
  const values: Record<string, string> = {};
  const lineOf: Record<string, number> = {};

  for (const { line, name: rawName, raw } of parseEnvLines(text)) {
    const add = (level: EnvFileProblem['level'], message: string, name?: string) => problems.push({ level, line, name, message });
    if (/^export\s/.test(rawName)) {
      add('error', 'Remove "export " at the start of the line: Docker does not accept it.');
      continue;
    }
    const name = rawName.trim();
    // Unknown names are only repeated when they resemble a known one: a key pasted on its own line must not be echoed.
    const isKnown = known.includes(name);
    const suggestion = isKnown || !NAME.test(name) ? undefined : suggest(name, known);
    const shown = isKnown || suggestion ? name : undefined;
    if (raw === null) {
      add(
        'error',
        shown
          ? `${shown} has no "=": write ${shown}=value, or delete the line.`
          : 'This line has no "=". If it is a key pasted on its own line, move it after the "=" of its variable; otherwise delete the line or put "#" in front.',
        shown,
      );
      continue;
    }
    if (!NAME.test(name)) {
      add('error', 'This line is not NAME=value; delete it or put "#" in front to make it a comment.');
      continue;
    }
    if (name !== rawName) {
      add('error', `Remove the space before "="${shown ? ` (${shown}=value)` : ''}. With spaces Docker refuses to start.`, shown);
      continue;
    }
    const label = shown ?? 'This variable';
    const previous = firstLine.get(name);
    if (previous !== undefined) add('warning', `${label} is also set on line ${previous}. Keep only one of the two lines.`, shown);
    else firstLine.set(name, line);
    if (!isKnown) {
      add(
        'warning',
        !suggestion
          ? 'ATLAS does not use this variable (name not shown in case it is a key). Check the spelling against .env.example, or delete the line.'
          : suggestion === name.toUpperCase()
            ? `ATLAS does not use ${name}. Did you mean ${suggestion}? Names are case-sensitive.`
            : `ATLAS does not use ${name}. Did you mean ${suggestion}?`,
        shown,
      );
    }

    if (raw === '') {
      values[name] = '';
      lineOf[name] = line;
      continue;
    }
    if (raw !== raw.trim()) {
      add('error', `${label} has spaces before or after the value. Remove them: Docker keeps them and the value would be wrong.`, shown);
    }
    let value = raw.trim();
    if (/^["'`]/.test(value)) {
      if (unquote(value) === value) {
        add('error', `${label} has an opening quote without a closing one. Remove the quote.`, shown);
        value = value.slice(1);
      } else {
        add('error', `${label} is in quotes. Remove them: with Docker (--env-file) the quotes become part of the value.`, shown);
        value = unquote(value);
      }
    } else if (/\s#/.test(value)) {
      add('warning', `${label} has a comment after the value. Put comments on their own line: Docker treats "#…" as part of the value.`, shown);
      value = value.replace(/\s+#.*$/, '');
    }
    values[name] = value;
    lineOf[name] = line;

    if (SECRETS.has(name) && value) {
      if (PLACEHOLDER.test(value)) {
        add('error', `${name} still contains placeholder text instead of a key.`, name);
      } else if (/\s/.test(value)) {
        add('error', `${name} contains a space. Keys never do: copy it again with the service's Copy button.`, name);
      } else {
        const format = KEY_FORMATS[name as SecretKey];
        if (format && !format.test.test(value)) {
          add('warning', `${name} does not look like the expected key (${format.hint}). Check that you copied the whole key into the right line.`, name);
        }
      }
    }
  }

  if (values.ATLAS_IP_HASH_SALT && PLACEHOLDER.test(values.ATLAS_IP_HASH_SALT)) {
    problems.push({ level: 'warning', line: lineOf.ATLAS_IP_HASH_SALT, name: 'ATLAS_IP_HASH_SALT', message: 'ATLAS_IP_HASH_SALT is still the example value; set a random one.' });
  }
  for (const name of ['DATABASE_URL', 'ATLAS_DATA_DIR']) {
    if (values[name]) {
      problems.push({
        level: 'warning',
        line: lineOf[name],
        name,
        message: `${name} is set. That is fine with npm, but if you run the Docker image with --env-file, put "#" in front of it: it would override the image's /data storage.`,
      });
    }
  }

  // The same key in two variables usually means one was pasted into the wrong line.
  const bySecret = new Map<string, string>();
  for (const name of SECRET_KEYS) {
    const v = values[name];
    if (!v) continue;
    const other = bySecret.get(v);
    if (other) {
      problems.push({ level: 'warning', line: lineOf[name], name, message: `${name} has the same value as ${other}. One of them is probably pasted into the wrong line.` });
    } else {
      bySecret.set(v, name);
    }
  }

  for (const issue of validateEnvValues(values)) {
    problems.push({
      level: 'error',
      line: lineOf[issue.key],
      name: issue.key,
      message: `${issue.key}: ATLAS would refuse this value (${issue.message}).`,
    });
  }

  return problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** API-key variables that have a value in a template; used to warn when keys were typed into .env.example. */
export function secretsInTemplate(text: string): string[] {
  return parseEnvLines(text)
    .filter((e) => SECRETS.has(e.name.trim()) && e.raw !== null && unquote(e.raw.trim()) !== '')
    .map((e) => e.name.trim());
}

/** Which API keys have a value (names only). */
export function secretsSet(text: string): { set: SecretKey[]; missing: SecretKey[] } {
  const present = new Set(
    parseEnvLines(text)
      .filter((e) => e.raw !== null && unquote(e.raw.trim()) !== '')
      .map((e) => e.name.trim()),
  );
  const keys = SECRET_KEYS.filter((k) => k !== 'REDIS_URL');
  return { set: keys.filter((k) => present.has(k)), missing: keys.filter((k) => !present.has(k)) };
}
