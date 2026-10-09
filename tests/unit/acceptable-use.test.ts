import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCEPTABLE_USE, ACCEPTABLE_USE_DATE, ACCEPTABLE_USE_VERSION } from '@/shared/acceptable-use';

describe('acceptable-use policy', () => {
  it('docs/ACCEPTABLE_USE.md matches the text shown in the app', () => {
    const md = fs.readFileSync(path.join(process.cwd(), 'docs/ACCEPTABLE_USE.md'), 'utf8');
    expect(md).toContain(`Version ${ACCEPTABLE_USE_VERSION} · ${ACCEPTABLE_USE_DATE}`);
    for (const text of [ACCEPTABLE_USE.intro, ACCEPTABLE_USE.responsibility, ...ACCEPTABLE_USE.appropriate, ...ACCEPTABLE_USE.must, ...ACCEPTABLE_USE.mustNot]) {
      expect(md, text).toContain(text);
    }
  });
});
