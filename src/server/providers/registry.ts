import type { AppEnv } from '../config/env';
import type { Provider } from './types';
import { DEMO_PROVIDERS } from './demo';
import { LOCAL_PROVIDERS } from './local';
import { ARTIFACT_PROVIDERS } from './artifacts';
import { dnsProvider } from './domain/dns';
import { rdapProvider } from './domain/rdap';
import { crtShProvider, waybackProvider } from './domain/history';
import { IP_PROVIDERS } from './ip';
import { SEARCH_PROVIDERS } from './search';
import { USERNAME_PROVIDERS } from './username';
import { EMAIL_PROVIDERS } from './email';
import { CRYPTO_PROVIDERS } from './crypto';
import { DARKWEB_PROVIDERS } from './darkweb';
import { GEO_PROVIDERS } from './geoint';
import { WEB_PROVIDERS } from './web';
import { correlationProvider } from '../engine/correlation';

export const ALL_PROVIDERS: Provider[] = [
  ...SEARCH_PROVIDERS,
  ...USERNAME_PROVIDERS,
  ...EMAIL_PROVIDERS,
  dnsProvider,
  rdapProvider,
  crtShProvider,
  waybackProvider,
  ...IP_PROVIDERS,
  ...CRYPTO_PROVIDERS,
  ...DARKWEB_PROVIDERS,
  ...GEO_PROVIDERS,
  ...WEB_PROVIDERS,
  ...LOCAL_PROVIDERS,
  ...ARTIFACT_PROVIDERS,
  ...DEMO_PROVIDERS,
  correlationProvider,
];

/**
 * Lightweight connectivity probes for keyless providers that do not define their own health check. Each probe hits
 * the same host the provider uses, with a non-personal subject (service metadata or a well-known organisation
 * account), and accepts 404 so that "reachable" is what is measured — not whether a particular record exists.
 */
const HEALTH_PROBES: Record<string, { url: (env: AppEnv) => string; message: string }> = {
  github: { url: () => 'https://api.github.com/users/github', message: 'GitHub REST API reachable.' },
  reddit: { url: () => 'https://www.reddit.com/user/reddit/about.json?raw_json=1', message: 'Reddit public JSON endpoint reachable.' },
  mastodon: {
    url: (env) => `https://${env.ATLAS_MASTODON_INSTANCES.split(',')[0]?.trim() || 'mastodon.social'}/api/v1/instance`,
    message: 'First configured Mastodon instance reachable.',
  },
  hackernews: { url: () => 'https://hacker-news.firebaseio.com/v0/maxitem.json', message: 'Hacker News Firebase API reachable.' },
  keybase: { url: () => 'https://keybase.io/_/api/1.0/user/lookup.json?usernames=keybase&fields=basics', message: 'Keybase lookup API reachable.' },
  bluesky: { url: () => 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app', message: 'Bluesky public AppView reachable.' },
  devto: { url: () => 'https://dev.to/api/users/by_username?url=ben', message: 'DEV (Forem) API reachable.' },
  gravatar: { url: () => 'https://api.gravatar.com/v3/profiles/00000000000000000000000000000000', message: 'Gravatar profiles API reachable.' },
  wayback: { url: () => 'https://web.archive.org/cdx/search/cdx?url=iana.org&limit=1&output=json', message: 'Wayback Machine CDX API reachable.' },
  'shodan.internetdb': { url: () => 'https://internetdb.shodan.io/8.8.8.8', message: 'Shodan InternetDB reachable.' },
  blockstream: { url: () => 'https://blockstream.info/api/blocks/tip/height', message: 'Blockstream Esplora API reachable.' },
  ipinfo: { url: () => 'https://ipinfo.io/8.8.8.8/json', message: 'IPinfo API reachable.' },
};

for (const p of ALL_PROVIDERS) {
  const probe = HEALTH_PROBES[p.id];
  if (!probe || p.healthCheck) continue;
  p.healthCheck = async (ctx) => {
    const t = Date.now();
    await ctx.http.request(probe.url(ctx.env), { allowStatus: [404] });
    return { status: 'healthy', message: probe.message, latencyMs: Date.now() - t };
  };
}

const byId = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
  return byId.get(id);
}

/** Test hook: register an additional provider (e.g. a failing stub) at runtime. */
export function registerProvider(p: Provider): void {
  if (!byId.has(p.id)) ALL_PROVIDERS.push(p);
  byId.set(p.id, p);
}

export interface ProviderConfigStatus {
  configured: boolean;
  missing: string[];
  optionalMissing: string[];
  envEnabled: boolean;
  disabledByAdmin: boolean;
}

export function providerConfigStatus(p: Provider, env: AppEnv): ProviderConfigStatus {
  const missing = p.config.filter((c) => !c.optional && !env[c.env]).map((c) => String(c.env));
  const optionalMissing = p.config.filter((c) => c.optional && !env[c.env]).map((c) => String(c.env));
  const disabled = (process.env.ATLAS_DISABLED_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const envEnabled = p.enabledByEnv ? p.enabledByEnv(env) : true;
  return {
    configured: missing.length === 0,
    missing,
    optionalMissing,
    envEnabled,
    disabledByAdmin: disabled.includes(p.id),
  };
}

/** Which provider kinds may run in a given investigation mode. Demo never touches live sources. */
export function providerAllowedInMode(p: Provider, mode: 'live' | 'demo'): boolean {
  if (p.kind === 'local') return true;
  return mode === 'demo' ? p.kind === 'simulated' : p.kind === 'live';
}

export function isProviderUsable(p: Provider, env: AppEnv): boolean {
  const s = providerConfigStatus(p, env);
  return s.configured && s.envEnabled && !s.disabledByAdmin;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  category: string;
  kind: string;
  description: string;
  homepage: string | null;
  docsUrl: string | null;
  reliability: string;
  operations: Array<{ id: string; label: string; targetTypes: string[]; module: string; minDepth: string }>;
  requires: Array<{ env: string; label: string; optional: boolean; present: boolean }>;
  status: ProviderConfigStatus;
  limitations: string[];
  rateLimit: { concurrency: number; minIntervalMs: number } | null;
  hasHealthCheck: boolean;
}

/** Public, secret-free description of a provider for the UI. */
export function describeProvider(p: Provider, env: AppEnv): ProviderDescriptor {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    kind: p.kind,
    description: p.description,
    homepage: p.homepage ?? null,
    docsUrl: p.docsUrl ?? null,
    reliability: p.reliability,
    operations: p.operations.map((o) => ({ ...o, targetTypes: [...o.targetTypes] })),
    requires: p.config.map((c) => ({ env: String(c.env), label: c.label, optional: Boolean(c.optional), present: Boolean(env[c.env]) })),
    status: providerConfigStatus(p, env),
    limitations: p.limitations ?? [],
    rateLimit: p.concurrency || p.minIntervalMs ? { concurrency: p.concurrency ?? 4, minIntervalMs: p.minIntervalMs ?? 0 } : null,
    hasHealthCheck: Boolean(p.healthCheck),
  };
}
