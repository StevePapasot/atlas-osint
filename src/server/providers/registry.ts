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
  ...LOCAL_PROVIDERS,
  ...ARTIFACT_PROVIDERS,
  ...DEMO_PROVIDERS,
  correlationProvider,
];

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
