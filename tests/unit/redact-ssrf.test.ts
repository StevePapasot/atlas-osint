import { describe, expect, it, afterEach } from 'vitest';
import { maskEmail, redactObject, redactSensitiveText, redactString } from '@/server/security/redact';
import { assertPublicHost, assertSafeUrlShape } from '@/server/security/ssrf';

describe('redaction', () => {
  it('redacts secret-looking keys recursively and inline secrets', () => {
    const r = redactObject({ api_key: 'abc', nested: { Authorization: 'Bearer x', ok: 1, list: [{ password: 'p' }] }, url: 'https://x.example/?api_key=SECRET&q=1' }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.api_key).toBe('[REDACTED]');
    expect(r.nested.Authorization).toBe('[REDACTED]');
    expect(r.nested.ok).toBe(1);
    expect(r.nested.list[0].password).toBe('[REDACTED]');
    expect(r.url).not.toContain('SECRET');
    expect(redactString('Authorization: Bearer abc.def')).not.toContain('abc.def');
  });
  it('masks emails and phone numbers in text', () => {
    expect(maskEmail('jane.doe@example.org')).toBe('j***@example.org');
    const t = redactSensitiveText('Contact jane@example.org or +44 20 7946 0958');
    expect(t).not.toContain('jane@');
    expect(t).not.toContain('7946');
  });
});

describe('SSRF protection', () => {
  afterEach(() => delete process.env.ATLAS_ALLOW_PRIVATE_EGRESS);
  it('blocks non-http schemes, credentials, unusual ports and private literals', () => {
    expect(() => assertSafeUrlShape('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrlShape('https://u:p@example.com/')).toThrow();
    expect(() => assertSafeUrlShape('http://example.com:22/')).toThrow();
    for (const u of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fc00::1]/', 'http://localhost/', 'http://metadata.google.internal/']) {
      expect(() => assertSafeUrlShape(u), u).toThrow();
    }
    expect(assertSafeUrlShape('https://example.com/a').hostname).toBe('example.com');
  });
  it('rejects hostnames resolving to private addresses', async () => {
    await expect(assertPublicHost('127.0.0.1')).rejects.toThrow();
    await expect(assertPublicHost('localhost')).rejects.toThrow();
    process.env.ATLAS_ALLOW_PRIVATE_EGRESS = 'true';
    await expect(assertPublicHost('127.0.0.1')).resolves.toEqual(['127.0.0.1']);
  });
});
