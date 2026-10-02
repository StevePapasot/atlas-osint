import 'server-only';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertPublicHost, assertSafeUrlShape, guardedLookup, SsrfBlockedError } from '../security/ssrf';
import { ProviderError, type HttpClient, type HttpRequestOptions, type HttpResponse } from './types';

const g = globalThis as unknown as { __atlasDispatcher?: Dispatcher; __atlasDispatcherProxy?: boolean };

function proxyConfigured(): boolean {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
}

/**
 * Outbound dispatcher. When an egress proxy is configured (corporate / sandbox networks) requests go through it;
 * otherwise a direct agent with a socket-level SSRF guard is used.
 */
export function dispatcher(): Dispatcher {
  const useProxy = proxyConfigured() && process.env.ATLAS_IGNORE_PROXY !== 'true';
  if (!g.__atlasDispatcher || g.__atlasDispatcherProxy !== useProxy) {
    g.__atlasDispatcher = useProxy
      ? new EnvHttpProxyAgent({ connect: { timeout: 10_000 } })
      : new Agent({ connect: { timeout: 10_000, lookup: guardedLookup } });
    g.__atlasDispatcherProxy = useProxy;
  }
  return g.__atlasDispatcher;
}

function describeNetworkError(err: unknown): { message: string; denied: boolean } {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const msg = cause?.message ?? (err instanceof Error ? err.message : String(err));
  const code = cause?.code ?? '';
  if (/Proxy response \((403|407)\)/i.test(msg)) {
    return { message: 'Egress to this host is denied by the network proxy policy.', denied: true };
  }
  // undici reports a refused proxy CONNECT tunnel as a generic cancellation.
  if (/Request was cancelled/i.test(msg) && proxyConfigured()) {
    return { message: 'Could not open a connection through the egress proxy (destination likely blocked by network policy).', denied: true };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { message: 'Host could not be resolved.', denied: false };
  if (code === 'ECONNREFUSED') return { message: 'Connection refused.', denied: false };
  if (code === 'ECONNRESET') return { message: 'Connection reset.', denied: false };
  if (/certificate/i.test(msg)) return { message: 'TLS certificate verification failed.', denied: true };
  return { message: msg.slice(0, 200) || 'Network error.', denied: false };
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderError('parse_error', `Response exceeded ${Math.round(maxBytes / 1024)} KB limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpClient(opts: { signal: AbortSignal; userAgent: string; defaultTimeoutMs: number }): HttpClient {
  return {
    async request(url: string, req: HttpRequestOptions = {}): Promise<HttpResponse> {
      let parsed: URL;
      try {
        parsed = assertSafeUrlShape(url);
        if (!proxyConfigured()) await assertPublicHost(parsed.hostname);
      } catch (err) {
        if (err instanceof SsrfBlockedError) throw new ProviderError('invalid_input', `Blocked unsafe URL: ${err.message}`);
        throw new ProviderError('network', describeNetworkError(err).message, true);
      }
      const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeoutSignal]);
      let res: Response;
      try {
        res = (await undiciFetch(parsed.toString(), {
          method: req.method ?? 'GET',
          headers: { 'user-agent': opts.userAgent, accept: 'application/json, text/plain;q=0.8, */*;q=0.5', ...req.headers },
          body: req.body,
          signal,
          redirect: 'follow',
          dispatcher: dispatcher(),
        })) as unknown as Response;
      } catch (err) {
        if (opts.signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
        if (timeoutSignal.aborted) throw new ProviderError('timeout', `Timed out after ${timeoutMs} ms.`, true);
        const d = describeNetworkError(err);
        throw new ProviderError('network', d.message, !d.denied);
      }
      const allow = new Set(req.allowStatus ?? []);
      if (!res.ok && !allow.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError('auth', `Access denied by provider (HTTP ${res.status}). Check credentials or access tier.`);
        }
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'));
          const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000;
          throw new ProviderError('rate_limited', 'Provider rate limit or quota reached (HTTP 429).', retryAfterMs <= 15000, retryAfterMs);
        }
        if (res.status >= 500) throw new ProviderError('upstream_error', `Provider error (HTTP ${res.status}).`, true);
        throw new ProviderError('upstream_error', `Unexpected response (HTTP ${res.status}).`);
      }
      let text: string;
      try {
        text = await readLimited(res, req.maxBytes ?? 4 * 1024 * 1024);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (timeoutSignal.aborted) throw new ProviderError('timeout', `Timed out after ${timeoutMs} ms.`, true);
        throw new ProviderError('network', describeNetworkError(err).message, true);
      }
      return {
        status: res.status,
        url: res.url || parsed.toString(),
        headers: res.headers,
        text,
        json<T>() {
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new ProviderError('parse_error', 'Provider returned malformed JSON.');
          }
        },
      };
    },
  };
}
