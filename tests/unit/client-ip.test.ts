import { describe, expect, it } from 'vitest';
import { clientIp } from '@/server/api/handler';

const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

describe('clientIp', () => {
  it('uses the rightmost X-Forwarded-For entry when no proxy is trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), 0)).toBe('203.0.113.9');
    // A forged leftmost entry is ignored when a proxy (or Next.js) appended the real address.
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), 0)).toBe('203.0.113.9');
  });

  it('picks the address appended by the outermost trusted proxy', () => {
    // client -> CDN -> nginx -> app: CDN appends the client, nginx appends the CDN.
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 192.0.2.10' }), 2)).toBe('198.51.100.7');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), 1)).toBe('198.51.100.7');
    // More hops configured than present: fall back to the leftmost entry rather than throwing.
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.7' }), 3)).toBe('198.51.100.7');
  });

  it('falls back to X-Real-IP and then null', () => {
    expect(clientIp(req({ 'x-real-ip': '192.0.2.44' }), 0)).toBe('192.0.2.44');
    expect(clientIp(req({}), 0)).toBeNull();
  });
});
