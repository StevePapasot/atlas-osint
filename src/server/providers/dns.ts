import 'server-only';
import { promises as dnsp } from 'node:dns';
import { ProviderError, type DnsClient } from './types';

const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN', 'ESERVFAIL_EMPTY']);

export function createDnsClient(opts: { servers?: string[]; timeoutMs?: number; signal?: AbortSignal }): DnsClient {
  const resolver = new dnsp.Resolver({ timeout: opts.timeoutMs ?? 4000, tries: 2 });
  if (opts.servers?.length) resolver.setServers(opts.servers);
  opts.signal?.addEventListener('abort', () => resolver.cancel(), { once: true });

  async function wrap<T>(fn: () => Promise<T>, empty: T): Promise<T> {
    if (opts.signal?.aborted) throw new ProviderError('cancelled', 'DNS query cancelled.');
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (EMPTY_CODES.has(code)) return empty;
      if (code === 'ECANCELLED') {
        const reason = opts.signal?.reason as { name?: string } | undefined;
        if (reason?.name === 'TimeoutError') throw new ProviderError('timeout', 'DNS query timed out.', true);
        throw new ProviderError('cancelled', 'DNS query cancelled.');
      }
      if (code === 'ETIMEOUT') throw new ProviderError('timeout', 'DNS query timed out.', true);
      if (code === 'ESERVFAIL') throw new ProviderError('upstream_error', 'DNS server failure (SERVFAIL).', true);
      if (code === 'EREFUSED') throw new ProviderError('network', 'DNS query refused.', true);
      if (code === 'EBADNAME' || code === 'EFORMERR') throw new ProviderError('invalid_input', 'Invalid DNS name.');
      throw new ProviderError('network', `DNS error ${code || (err as Error).message}`, true);
    }
  }

  return {
    resolve4: (n) => wrap(() => resolver.resolve4(n), []),
    resolve6: (n) => wrap(() => resolver.resolve6(n), []),
    resolveMx: (n) => wrap(() => resolver.resolveMx(n), []),
    resolveNs: (n) => wrap(() => resolver.resolveNs(n), []),
    resolveTxt: (n) => wrap(() => resolver.resolveTxt(n), []),
    resolveCname: (n) => wrap(() => resolver.resolveCname(n), []),
    resolveCaa: (n) => wrap(async () => (await resolver.resolveCaa(n)) as unknown as Array<Record<string, unknown>>, []),
    resolveSoa: (n) => wrap(async () => (await resolver.resolveSoa(n)) as { nsname: string; hostmaster: string; serial: number } | null, null),
    reverse: (ip) => wrap(() => resolver.reverse(ip), []),
  };
}
