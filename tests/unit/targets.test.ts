import { describe, expect, it } from 'vitest';
import { canonicalUrlKey, detectTargetType, normalizeTarget, parseProfileUrl, normalizeIp } from '@/shared/targets';

describe('target validation & normalization', () => {
  it('normalizes emails (case, mailto) and rejects malformed ones', () => {
    const r = normalizeTarget('email', 'mailto:J.Doe@Example.ORG');
    expect(r).toMatchObject({ ok: true, normalized: 'j.doe@example.org', metadata: { domain: 'example.org' } });
    for (const bad of ['no-at-sign', 'a@b', '.a@example.org', 'a..b@example.org', 'a@-example.org']) {
      expect(normalizeTarget('email', bad).ok).toBe(false);
    }
  });

  it('normalizes domains including IDN and trailing dots; rejects IPs, file names and junk', () => {
    expect(normalizeTarget('domain', 'EXAMPLE.com.')).toMatchObject({ ok: true, normalized: 'example.com' });
    expect(normalizeTarget('domain', 'bücher.example')).toMatchObject({ ok: true, normalized: 'xn--bcher-kva.example' });
    for (const bad of ['198.51.100.4', 'report.pdf', 'localhost', 'exa mple.com', 'http://example.com', '-bad.com']) {
      expect(normalizeTarget('domain', bad).ok, bad).toBe(false);
    }
  });

  it('canonicalizes IPv4/IPv6 and flags non-public ranges', () => {
    expect(normalizeTarget('ip', '2001:0DB8:0000:0000:0000:0000:0000:0001')).toMatchObject({ ok: true, normalized: '2001:db8::1', metadata: { version: 6, isPublic: false } });
    expect(normalizeTarget('ip', '::ffff:8.8.8.8')).toMatchObject({ ok: true, normalized: '8.8.8.8', metadata: { isPublic: true } });
    expect(normalizeIp('10.0.0.1')?.isPublic).toBe(false);
    expect(normalizeIp('127.0.0.1')?.isPublic).toBe(false);
    expect(normalizeTarget('ip', '010.1.1.1').ok).toBe(false);
    expect(normalizeTarget('ip', '300.1.1.1').ok).toBe(false);
  });

  it('strips tracking parameters and fragments from URLs and rejects credentials or other schemes', () => {
    expect(normalizeTarget('url', 'example.com/path?utm_source=x&a=1#frag')).toMatchObject({ ok: true, normalized: 'https://example.com/path?a=1' });
    expect(normalizeTarget('url', 'https://user:pw@example.com').ok).toBe(false);
    expect(normalizeTarget('url', 'javascript:alert(1)').ok).toBe(false);
    expect(normalizeTarget('url', 'file:///etc/passwd').ok).toBe(false);
  });

  it('extracts usernames from profile URLs', () => {
    expect(parseProfileUrl('https://github.com/octocat')).toEqual({ platform: 'github', username: 'octocat' });
    expect(parseProfileUrl('https://infosec.exchange/@alice')).toEqual({ platform: 'mastodon', username: 'alice', instance: 'infosec.exchange' });
    expect(normalizeTarget('username', '@Shadow_Fox')).toMatchObject({ ok: true, normalized: 'shadow_fox', display: 'Shadow_Fox' });
    expect(normalizeTarget('username', 'has space').ok).toBe(false);
  });

  it('parses phone numbers to E.164 with country', () => {
    expect(normalizeTarget('phone', '+44 20 7946 0958')).toMatchObject({ ok: true, normalized: '+442079460958', metadata: { country: 'GB', type: 'FIXED_LINE' } });
    expect(normalizeTarget('phone', '020 7946 0958', { defaultCountry: 'GB' })).toMatchObject({ ok: true, normalized: '+442079460958' });
    expect(normalizeTarget('phone', '12').ok).toBe(false);
  });

  it('validates cryptocurrency checksums', () => {
    expect(normalizeTarget('crypto', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toMatchObject({ ok: true, metadata: { chain: 'bitcoin', format: 'base58' } });
    expect(normalizeTarget('crypto', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toMatchObject({ ok: true, metadata: { format: 'bech32' } });
    expect(normalizeTarget('crypto', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toMatchObject({ ok: true, normalized: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' });
    // Bad EIP-55 checksum (last character case flipped) and bad base58 checksum.
    expect(normalizeTarget('crypto', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').ok).toBe(false);
    expect(normalizeTarget('crypto', '1BoatSLRHtKNngkdXEeobR76b53LETtpyU').ok).toBe(false);
  });

  it('rejects names with markup or without letters', () => {
    expect(normalizeTarget('person', 'Jane   Doe')).toMatchObject({ ok: true, normalized: 'jane doe', display: 'Jane Doe' });
    expect(normalizeTarget('person', '<script>x</script>').ok).toBe(false);
    expect(normalizeTarget('person', '1234').ok).toBe(false);
    expect(normalizeTarget('keyword', '').ok).toBe(false);
  });

  it('detects likely target types', () => {
    expect(detectTargetType('j.doe@example.org')).toBe('email');
    expect(detectTargetType('198.51.100.7')).toBe('ip');
    expect(detectTargetType('example.com')).toBe('domain');
    expect(detectTargetType('https://github.com/x')).toBe('username');
    expect(detectTargetType('https://example.com/a.pdf')).toBe('document');
    expect(detectTargetType('@shadowfox')).toBe('username');
    expect(detectTargetType('Jane Doe')).toBe('person');
    expect(detectTargetType('+1 202 555 0143')).toBe('phone');
  });

  it('produces one canonical key for equivalent URLs (deduplication)', () => {
    expect(canonicalUrlKey('https://www.Example.com/a/?b=2&a=1&utm_source=z#x')).toBe(canonicalUrlKey('http://example.com/a?a=1&b=2'));
    expect(canonicalUrlKey('https://example.com/a')).not.toBe(canonicalUrlKey('https://example.com/b'));
  });
});
