import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isPublicIp, normalizeIp } from '@/shared/targets';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export function privateEgressAllowed(): boolean {
  return process.env.ATLAS_ALLOW_PRIVATE_EGRESS === 'true';
}

/** Static URL checks: scheme, credentials, port and literal IP addresses. */
export function assertSafeUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Malformed URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SsrfBlockedError('Only http(s) URLs may be fetched.');
  if (u.username || u.password) throw new SsrfBlockedError('URLs with embedded credentials are not fetched.');
  if (!ALLOWED_PORTS.has(u.port) && !privateEgressAllowed()) throw new SsrfBlockedError(`Port ${u.port} is not permitted.`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (normalizeIp(host) && !isPublicIp(host) && !privateEgressAllowed()) {
    throw new SsrfBlockedError('Requests to private, loopback or reserved addresses are blocked.');
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host) && !privateEgressAllowed()) {
    throw new SsrfBlockedError('Requests to internal hostnames are blocked.');
  }
  return u;
}

/** Resolve a hostname and ensure every address is public unicast. */
export async function assertPublicHost(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (normalizeIp(host)) {
    if (!isPublicIp(host) && !privateEgressAllowed()) throw new SsrfBlockedError('Destination address is not public.');
    return [host];
  }
  const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new SsrfBlockedError('Hostname did not resolve.');
  if (!privateEgressAllowed()) {
    for (const a of addrs) {
      if (!isPublicIp(a.address)) throw new SsrfBlockedError(`Hostname resolves to a non-public address (${a.address}).`);
    }
  }
  return addrs.map((a) => a.address);
}

/**
 * Socket-level lookup used for direct (non-proxied) connections, so the address actually connected to is the
 * one that was validated (prevents DNS-rebinding TOCTOU).
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    if (!privateEgressAllowed()) {
      const bad = list.find((a) => !isPublicIp(a.address));
      if (bad) {
        return callback(new SsrfBlockedError(`Blocked non-public destination ${bad.address}`) as NodeJS.ErrnoException, '', 4);
      }
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
};
