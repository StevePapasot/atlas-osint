import { describe, expect, it } from 'vitest';
import { assessConfidence } from '@/server/engine/confidence';

const base = { claimType: 'SOURCE_CLAIM' as const, reliabilities: ['reputable' as const], matchTypes: ['exact' as const], providerCount: 1, verificationStatus: 'unreviewed' as const, isSimulated: false };

describe('confidence assessment', () => {
  it('rates a direct authoritative observation high', () => {
    expect(assessConfidence({ ...base, claimType: 'FACT', reliabilities: ['authoritative'] }).level).toBe('high');
  });
  it('rates a reputable source claim moderate and explains why', () => {
    const a = assessConfidence(base);
    expect(a.level).toBe('moderate');
    expect(a.rationale.join(' ')).toMatch(/reputable/);
    expect(a.rationale.join(' ')).toMatch(/Single provider/);
  });
  it('increases with independent corroboration (capped at +2)', () => {
    const two = assessConfidence({ ...base, providerCount: 2 });
    const five = assessConfidence({ ...base, providerCount: 5 });
    expect(two.score).toBe(assessConfidence(base).score + 1);
    expect(five.score).toBe(assessConfidence(base).score + 2);
    expect(five.level).toBe('high');
  });
  it('caps single-source unverified leads at low', () => {
    expect(assessConfidence({ ...base, claimType: 'UNVERIFIED_LEAD', reliabilities: ['authoritative'] }).level).toBe('low');
    expect(assessConfidence({ ...base, claimType: 'UNVERIFIED_LEAD', reliabilities: ['authoritative'], providerCount: 2 }).level).not.toBe('low');
  });
  it('penalises inference and fuzzy matches', () => {
    expect(assessConfidence({ ...base, claimType: 'INFERENCE', reliabilities: ['unknown'], matchTypes: ['fuzzy'] }).level).toBe('unverified');
  });
  it('lets analyst decisions override', () => {
    expect(assessConfidence({ ...base, verificationStatus: 'verified' }).level).toBe('verified');
    expect(assessConfidence({ ...base, claimType: 'FACT', reliabilities: ['authoritative'], verificationStatus: 'disputed' }).level).toBe('low');
    expect(assessConfidence({ ...base, verificationStatus: 'false_positive' }).level).toBe('unverified');
  });
  it('flags simulated data in the rationale', () => {
    expect(assessConfidence({ ...base, isSimulated: true }).rationale.join(' ')).toMatch(/SIMULATED/);
  });
});
