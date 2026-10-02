import { describe, expect, it } from 'vitest';
import { MIN_NODE_VERSION, nodeVersionProblem } from '@/server/config/runtime';

describe('nodeVersionProblem', () => {
  it('rejects Node versions that crash the SQLite driver or lack undici support', () => {
    for (const v of ['22.12.0', '22.13.1', '22.18.9', '20.19.0', 'v18.20.4']) expect(nodeVersionProblem(v), v).toMatch(/needs Node\.js 22\.19\.0 or newer/);
  });
  it('accepts supported versions', () => {
    for (const v of [MIN_NODE_VERSION, '22.22.0', 'v24.11.1', '25.0.0', '26.1.0']) expect(nodeVersionProblem(v), v).toBeNull();
  });
});
