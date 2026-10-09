import 'server-only';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { redactSensitiveText, redactString } from '../security/redact';
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
  const code = cause?.code ?? (err as { code?: string })?.code ?? '';
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

/** The message part of common API error bodies: Brave/VirusTotal/Google `{error: {code, detail|message}}`,
 * AbuseIPDB `{errors: [{detail}]}`, SerpApi/Shodan `{error: "…"}`, GitHub `{message}`, FastAPI `{detail}`. */
function errorMessageFromJson(body: unknown): string {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const o = body as Record<string, unknown>;
  const str = (...vals: unknown[]) => vals.find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const err = o.error ?? (Array.isArray(o.errors) ? o.errors[0] : undefined);
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return [str(e.code, e.status, e.type), str(e.detail, e.message, e.title, e.msg)].filter(Boolean).join(': ');
  }
  const detail = Array.isArray(o.detail) ? (o.detail[0] as { msg?: unknown } | undefined)?.msg : o.detail;
  return str(o.message, detail, o.title, o.error_description) ?? '';
}

/**
 * A short, single-line explanation from an error response, so users see why a provider refused a request
 * (for example Brave's `SUBSCRIPTION_TOKEN_INVALID`). The request's own credentials and anything that looks like a
 * key or personal identifier are removed; HTML pages are ignored.
 */
export function errorDetail(text: string, contentType: string, credentials: string[]): string {
  const t = text.trim();
  if (!t || /html/i.test(contentType) || t.startsWith('<')) return '';
  let detail = '';
  try {
    detail = errorMessageFromJson(JSON.parse(t));
  } catch {
    detail = /json/i.test(contentType) ? '' : (t.split('\n')[0] ?? '');
  }
  for (const c of credentials) if (c.length >= 6) detail = detail.split(c).join('[REDACTED]');
  detail = redactSensitiveText(redactString(detail))
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

/** Request headers that never carry credentials (everything else is treated as secret in error details). */
const PLAIN_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'user-agent', 'parallel-beta']);
const MAX_REDIRECTS = 5;
/** Headers that may follow a redirect to a different origin; everything else (API keys!) is dropped. */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'accept-language']);

async function validateDestination(raw: string, strictDns: boolean): Promise<URL> {
  const u = assertSafeUrlShape(raw);
  // Behind an egress proxy the proxy resolves names, so fixed provider endpoints skip the local DNS check. URLs that
  // came from users or documents are always checked, and must resolve to public addresses (fail closed).
  if (!proxyConfigured() || strictDns) await assertPublicHost(u.hostname);
  return u;
}

export function createHttpClient(opts: { signal: AbortSignal; userAgent: string; defaultTimeoutMs: number }): HttpClient {
  return {
    async request(url: string, req: HttpRequestOptions = {}): Promise<HttpResponse> {
      const strict = Boolean(req.untrustedUrl);
      if (strict && (req.method ?? 'GET') !== 'GET') throw new ProviderError('invalid_input', 'Only GET is permitted for untrusted URLs.');
      const toProviderError = (err: unknown) =>
        err instanceof SsrfBlockedError ? new ProviderError('invalid_input', `Blocked unsafe URL: ${err.message}`) : new ProviderError('network', describeNetworkError(err).message, true);
      let parsed: URL;
      try {
        parsed = await validateDestination(url, strict);
      } catch (err) {
        throw toProviderError(err);
      }
      const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeoutSignal]);
      // A caller's own deadline (e.g. a health check's AbortSignal.timeout) is a timeout too, not a cancellation.
      const callerTimedOut = () => (opts.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
      const timedOut = () => new ProviderError('timeout', `No answer within ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}.`, true);
      const origin = parsed.origin;
      let method = req.method ?? 'GET';
      let body = req.body;
      let headers: Record<string, string> = { 'user-agent': opts.userAgent, accept: 'application/json, text/plain;q=0.8, */*;q=0.5', ...req.headers };
      let res: Response;
      // Redirects are followed manually so every hop is re-validated (scheme, port, credentials, public address)
      // and provider credentials never leak to another origin.
      for (let hop = 0; ; hop++) {
        try {
          res = (await undiciFetch(parsed.toString(), { method, headers, body, signal, redirect: 'manual', dispatcher: dispatcher() })) as unknown as Response;
        } catch (err) {
          if (timeoutSignal.aborted || callerTimedOut()) throw timedOut();
          if (opts.signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.');
          const d = describeNetworkError(err);
          throw new ProviderError('network', d.message, !d.denied);
        }
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new ProviderError('upstream_error', `Too many redirects (more than ${MAX_REDIRECTS}).`);
        try {
          parsed = await validateDestination(new URL(location, parsed).toString(), strict);
        } catch (err) {
          throw toProviderError(err);
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        if (parsed.origin !== origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() === 'user-agent' || CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase())));
        }
      }
      const allow = new Set(req.allowStatus ?? []);
      if (!res.ok && !allow.has(res.status)) {
        // Error bodies of fixed provider endpoints explain the refusal; content from untrusted URLs is never shown.
        let detail = '';
        if (strict) {
          await res.body?.cancel().catch(() => undefined);
        } else {
          const body = await readLimited(res, 16 * 1024).catch(() => '');
          const credentials = [
            ...Object.entries(req.headers ?? {})
              .filter(([k]) => !PLAIN_HEADERS.has(k.toLowerCase()))
              .flatMap(([, v]) => [v, v.replace(/^(Bearer|Basic|token)\s+/i, '')]),
            ...new URL(url).searchParams.values(),
          ];
          detail = errorDetail(body, res.headers.get('content-type') ?? '', credentials);
        }
        const sentence = (head: string) => (detail ? `${head}: ${detail}${/[.!?…]$/.test(detail) ? '' : '.'}` : `${head}.`);
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError('auth', `${sentence(`Access denied by provider (HTTP ${res.status})`)} Check credentials or access tier.`);
        }
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'));
          const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000;
          throw new ProviderError('rate_limited', sentence('Provider rate limit or quota reached (HTTP 429)'), retryAfterMs <= 15000, retryAfterMs);
        }
        if (res.status >= 500) throw new ProviderError('upstream_error', sentence(`Provider error (HTTP ${res.status})`), true);
        throw new ProviderError('upstream_error', sentence(`Provider rejected the request (HTTP ${res.status})`));
      }
      let text: string;
      try {
        text = await readLimited(res, req.maxBytes ?? 4 * 1024 * 1024);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (timeoutSignal.aborted || callerTimedOut()) throw timedOut();
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
