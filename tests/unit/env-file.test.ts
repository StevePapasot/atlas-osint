import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvFile, decodeEnvFile, secretsInTemplate, secretsSet, templateNames } from '@/server/config/env-file';
import { ENV_KEYS } from '@/server/config/env';

// Fictional values in the documented formats; none of them is a real credential.
const KEYS = {
  BRAVE_SEARCH_API_KEY: `BSA${'Fict1onal'.repeat(3)}`,
  GITHUB_TOKEN_OSINT: `ghp_${'F1ct'.repeat(9)}`,
  YOUTUBE_API_KEY: `AIza${'Fictional_'.repeat(3)}abcde`,
  VIRUSTOTAL_API_KEY: '0f'.repeat(32),
  SHODAN_API_KEY: 'Fictional1'.repeat(3) + 'ab',
  ETHERSCAN_API_KEY: 'FICTIONAL1'.repeat(3) + 'ABCD',
  INTELX_API_KEY: '0000aaaa-1111-2222-3333-444455556666',
  IPINFO_TOKEN: 'f1c7f1c7f1c7f1',
};

const example = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
const known = templateNames(example);
const check = (text: string) => checkEnvFile(text, known);
const withKeys = (keys: Record<string, string>) =>
  example
    .split('\n')
    .map((l) => {
      const name = l.split('=')[0]!;
      return name in keys ? `${name}=${keys[name]}` : l;
    })
    .join('\n');

describe('checkEnvFile', () => {
  it('accepts the template and a file with well-formed keys, including CRLF line endings', () => {
    expect(check(example)).toEqual([]);
    expect(check(withKeys(KEYS))).toEqual([]);
    expect(check(withKeys(KEYS).replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('documents every configuration variable in .env.example', () => {
    expect(ENV_KEYS.filter((k) => k !== 'NODE_ENV' && !known.includes(k))).toEqual([]);
  });

  it('flags syntax that Docker --env-file reads differently from Next.js', () => {
    const text = [
      `BRAVE_SEARCH_API_KEY="${KEYS.BRAVE_SEARCH_API_KEY}"`,
      `GITHUB_TOKEN_OSINT= ${KEYS.GITHUB_TOKEN_OSINT}`,
      `VIRUSTOTAL_API_KEY = ${KEYS.VIRUSTOTAL_API_KEY}`,
      `export SHODAN_API_KEY=${KEYS.SHODAN_API_KEY}`,
      `ETHERSCAN_API_KEY=${KEYS.ETHERSCAN_API_KEY} # mine`,
      `YOUTUBE_API_KEY='${KEYS.YOUTUBE_API_KEY}`,
      'some stray text',
    ].join('\n');
    const problems = check(text);
    const at = (line: number) => problems.filter((p) => p.line === line).map((p) => `${p.level}: ${p.message}`);
    expect(at(1)).toEqual([expect.stringMatching(/^error: BRAVE_SEARCH_API_KEY is in quotes/)]);
    expect(at(2)).toEqual([expect.stringMatching(/^error: GITHUB_TOKEN_OSINT has spaces before or after the value/)]);
    expect(at(3)).toEqual([expect.stringMatching(/^error: Remove the space before "="/)]);
    expect(at(4)).toEqual([expect.stringMatching(/^error: Remove "export "/)]);
    expect(at(5)).toEqual([expect.stringMatching(/^warning: ETHERSCAN_API_KEY has a comment after the value/)]);
    expect(at(6)).toEqual([expect.stringMatching(/^error: YOUTUBE_API_KEY has an opening quote without a closing one/)]);
    expect(at(7)).toEqual([expect.stringMatching(/^error: This line has no "="\. If it is a key pasted on its own line/)]);
  });

  it('flags placeholders, keys in the wrong line, duplicates and typos in names', () => {
    const problems = check(
      [
        'SHODAN_API_KEY=<your key>',
        `YOUTUBE_API_KEY=${KEYS.GITHUB_TOKEN_OSINT}`,
        `GITHUB_TOKEN_OSINT=${KEYS.GITHUB_TOKEN_OSINT}`,
        'IPINFO_TOKEN=',
        `IPINFO_TOKEN=${KEYS.IPINFO_TOKEN}`,
        `BRAVE_API_KEY=${KEYS.BRAVE_SEARCH_API_KEY}`,
        `brave_search_api_key=${KEYS.BRAVE_SEARCH_API_KEY}`,
        `VIRUSTOTAL_APIKEY=${KEYS.VIRUSTOTAL_API_KEY}`,
        `VIRUSTOTAL_API_KEY=${KEYS.VIRUSTOTAL_API_KEY.slice(0, 40)}`,
        `ETHERSCAN_API_KEY=${KEYS.ETHERSCAN_API_KEY.slice(0, 10)} ${KEYS.ETHERSCAN_API_KEY.slice(10)}`,
      ].join('\n'),
    );
    const messages = problems.map((p) => `${p.line} ${p.level}: ${p.message}`);
    expect(messages).toEqual([
      '1 error: SHODAN_API_KEY still contains placeholder text instead of a key.',
      expect.stringMatching(/^2 warning: YOUTUBE_API_KEY does not look like the expected key \(Google API keys start with "AIza"/),
      '2 warning: YOUTUBE_API_KEY has the same value as GITHUB_TOKEN_OSINT. One of them is probably pasted into the wrong line.',
      '5 warning: IPINFO_TOKEN is also set on line 4. Keep only one of the two lines.',
      '6 warning: ATLAS does not use BRAVE_API_KEY. Did you mean BRAVE_SEARCH_API_KEY?',
      '7 warning: ATLAS does not use brave_search_api_key. Did you mean BRAVE_SEARCH_API_KEY? Names are case-sensitive.',
      '8 warning: ATLAS does not use VIRUSTOTAL_APIKEY. Did you mean VIRUSTOTAL_API_KEY?',
      expect.stringMatching(/^9 warning: VIRUSTOTAL_API_KEY does not look like the expected key \(VirusTotal API keys are 64 hexadecimal/),
      expect.stringMatching(/^10 error: ETHERSCAN_API_KEY contains a space/),
    ]);
  });

  it('reports values the app would refuse to start with', () => {
    const problems = check(['ATLAS_ENABLE_AHMIA=on', 'ATLAS_MAX_UPLOAD_MB=lots', 'ATLAS_SOURCE_URL=not a url'].join('\n'));
    expect(problems.map((p) => [p.line, p.level, p.name])).toEqual([
      [1, 'error', 'ATLAS_ENABLE_AHMIA'],
      [2, 'error', 'ATLAS_MAX_UPLOAD_MB'],
      [3, 'error', 'ATLAS_SOURCE_URL'],
    ]);
    expect(problems[0]!.message).toMatch(/ATLAS would refuse this value \(Invalid option: expected one of/);
  });

  it('warns about settings that break the Docker image or are left at the example value', () => {
    const problems = check(['DATABASE_URL=file:./data/atlas.db', 'ATLAS_DATA_DIR=./data', 'ATLAS_IP_HASH_SALT=change-me'].join('\n'));
    expect(problems.map((p) => [p.line, p.level, p.name])).toEqual([
      [1, 'warning', 'DATABASE_URL'],
      [2, 'warning', 'ATLAS_DATA_DIR'],
      [3, 'warning', 'ATLAS_IP_HASH_SALT'],
    ]);
  });

  it('never includes values in its messages', () => {
    const secretish = 'Zq9SecretValueThatMustNotLeak';
    const lines = [
      `BRAVE_SEARCH_API_KEY="${secretish}"`,
      `SERPAPI_API_KEY= ${secretish}x`,
      `YOUTUBE_API_KEY=${secretish}y # note`,
      `MY_${secretish}=1`,
      // A key pasted on its own line, with or without base64 padding.
      secretish,
      `${secretish}==`,
      ` ${secretish} = x`,
      `IPINFO_TOKEN=${secretish}`,
      `IPINFO_TOKEN=${secretish}`,
      `SHODAN_API_KEY=${secretish} with space`,
      `ATLAS_SOURCE_URL=${secretish}`,
      `ATLAS_LOG_LEVEL=${secretish}`,
      `VIRUSTOTAL_API_KEY=${secretish}`,
      `ABUSEIPDB_API_KEY=${secretish}`,
    ];
    const problems = check(lines.join('\n'));
    expect(problems.length).toBeGreaterThan(5);
    for (const p of problems) expect(p.message).not.toContain('SecretValue');
  });

  it('handles byte-order marks and UTF-16 files', () => {
    expect(checkEnvFile(`﻿${example}`, known)).toEqual([]);
    expect(checkEnvFile(`﻿BRAVE_SEARCH_API_KEY=${KEYS.BRAVE_SEARCH_API_KEY}`, known).map((p) => p.message)).toEqual([
      expect.stringMatching(/byte-order mark/),
    ]);
    expect(decodeEnvFile(Buffer.from(example, 'utf16le'))).toBeNull();
    expect(decodeEnvFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(example, 'utf16le')]))).toBeNull();
    expect(decodeEnvFile(Buffer.from(example, 'utf8'))).toBe(example);
  });
});

describe('secretsSet and secretsInTemplate', () => {
  it('lists which API keys have a value, by name only', () => {
    const { set, missing } = secretsSet(withKeys({ BRAVE_SEARCH_API_KEY: KEYS.BRAVE_SEARCH_API_KEY, IPINFO_TOKEN: `"${KEYS.IPINFO_TOKEN}"`, SHODAN_API_KEY: '""' }));
    expect(set).toEqual(['BRAVE_SEARCH_API_KEY', 'IPINFO_TOKEN']);
    expect(missing).toContain('SHODAN_API_KEY');
    expect(missing).not.toContain('REDIS_URL');
  });

  it('detects keys typed into .env.example', () => {
    expect(secretsInTemplate(example)).toEqual([]);
    expect(secretsInTemplate(withKeys({ SHODAN_API_KEY: KEYS.SHODAN_API_KEY }))).toEqual(['SHODAN_API_KEY']);
  });
});
