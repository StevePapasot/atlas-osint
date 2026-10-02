/** Utilities for testing providers without network access: scripted HTTP and DNS clients. */
import { ProviderError, type DnsClient, type HttpClient, type HttpRequestOptions, type HttpResponse, type ProviderContext, type ProviderInput } from '@/server/providers/types';
import { env } from '@/server/config/env';
import type { TargetType } from '@/shared/domain';

type Responder = (url: string, opts: HttpRequestOptions) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | ProviderError;

export function fakeHttp(responder: Responder): HttpClient & { calls: Array<{ url: string; opts: HttpRequestOptions }> } {
  const calls: Array<{ url: string; opts: HttpRequestOptions }> = [];
  return {
    calls,
    async request(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
      calls.push({ url, opts });
      const r = responder(url, opts);
      if (r instanceof ProviderError) throw r;
      const status = r.status ?? 200;
      if (status >= 400 && !(opts.allowStatus ?? []).includes(status)) {
        if (status === 401 || status === 403) throw new ProviderError('auth', `HTTP ${status}`);
        if (status === 429) throw new ProviderError('rate_limited', 'HTTP 429', true);
        throw new ProviderError('upstream_error', `HTTP ${status}`, status >= 500);
      }
      const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
      return {
        status,
        url,
        headers: new Headers(r.headers ?? {}),
        text,
        json<T>() {
          return JSON.parse(text) as T;
        },
      };
    },
  };
}

export function fakeDns(records: Partial<Record<keyof DnsClient, Record<string, unknown>>> = {}): DnsClient {
  const get = <T,>(kind: keyof DnsClient, name: string, empty: T): Promise<T> => {
    const table = records[kind] ?? {};
    const v = table[name];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve((v as T) ?? empty);
  };
  return {
    resolve4: (n) => get('resolve4', n, []),
    resolve6: (n) => get('resolve6', n, []),
    resolveMx: (n) => get('resolveMx', n, []),
    resolveNs: (n) => get('resolveNs', n, []),
    resolveTxt: (n) => get('resolveTxt', n, []),
    resolveCname: (n) => get('resolveCname', n, []),
    resolveCaa: (n) => get('resolveCaa', n, []),
    resolveSoa: (n) => get('resolveSoa', n, null),
    reverse: (ip) => get('reverse', ip, []),
  };
}

export function ctx(http: HttpClient, dns: DnsClient = fakeDns(), overrides: Partial<ReturnType<typeof env>> = {}): ProviderContext {
  return {
    signal: new AbortController().signal,
    env: { ...env(), ...overrides },
    timeoutMs: 5000,
    http,
    dns,
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    log: () => undefined,
  };
}

export function input(type: TargetType, value: string, extra: Partial<ProviderInput> = {}, display = value): ProviderInput {
  return {
    subject: { type, value, display, metadata: {}, targetId: null, entityId: null },
    operation: '',
    params: {},
    depth: 'standard',
    investigation: { id: '00000000-0000-0000-0000-000000000001', name: 'Test', scopeStatement: null, mode: 'live' },
    relatedTargets: [],
    ...extra,
  };
}
