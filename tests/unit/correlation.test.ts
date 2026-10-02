import { describe, expect, it } from 'vitest';
import { compareAccounts, jaccard } from '@/server/engine/correlation';

const acct = (over: Partial<Parameters<typeof compareAccounts>[0]>) => ({
  id: 'x', value: 'p:x', platform: 'GitHub', username: 'shadowfox', displayName: null, website: null, bio: null, location: null, emails: [], isSimulated: false, ...over,
});

describe('entity resolution signals', () => {
  it('treats a shared username alone as a weak signal', () => {
    const r = compareAccounts(acct({ id: 'a' }), acct({ id: 'b', platform: 'GitLab' }));
    expect(r?.strength).toBe('weak');
    expect(r?.signals.map((s) => s.signal)).toEqual(['same_username']);
  });
  it('treats a shared website or email as strong', () => {
    expect(compareAccounts(acct({ website: 'https://www.jd.example' }), acct({ platform: 'Reddit', username: 'other', website: 'https://jd.example/about' }))?.strength).toBe('strong');
    expect(compareAccounts(acct({ emails: ['j@example.org'] }), acct({ platform: 'npm', username: 'zz', emails: ['j@example.org'] }))?.strength).toBe('strong');
  });
  it('treats a matching display name or similar bio as moderate', () => {
    expect(compareAccounts(acct({ displayName: 'Jane Doe' }), acct({ platform: 'Keybase', username: 'jd', displayName: 'jane doe' }))?.strength).toBe('moderate');
    expect(compareAccounts(acct({ bio: 'Builds data pipelines and maps in Lisbon' }), acct({ platform: 'DEV', username: 'q', bio: 'Builds data pipelines and maps' }))?.strength).toBe('moderate');
  });
  it('never compares accounts on the same platform and returns null without signals', () => {
    expect(compareAccounts(acct({}), acct({}))).toBeNull();
    expect(compareAccounts(acct({ username: 'a' }), acct({ platform: 'GitLab', username: 'b' }))).toBeNull();
  });
  it('computes Jaccard similarity', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set(['b']))).toBe(0);
  });
});
