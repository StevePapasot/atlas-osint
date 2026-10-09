import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { nowIso, toJson } from '../db/json';
import { env } from '../config/env';
import { ALL_PROVIDERS, describeProvider, getProvider, isProviderUsable } from '../providers/registry';
import { createHttpClient } from '../providers/http';
import { createDnsClient } from '../providers/dns';
import { ProviderError } from '../providers/types';
import { notFound } from '../api/errors';
import { recordProviderHealth } from '../engine/runner';

export async function listProvidersForUser(userId: string) {
  const e = env();
  const prefs = await db().selectFrom('provider_configurations').select(['provider_id', 'enabled']).where('user_id', '=', userId).execute();
  const health = await db().selectFrom('provider_health').selectAll().execute();
  return ALL_PROVIDERS.filter((p) => p.category !== 'analysis').map((p) => {
    const pref = prefs.find((x) => x.provider_id === p.id);
    const h = health.find((x) => x.provider_id === p.id);
    return {
      ...describeProvider(p, e),
      usable: isProviderUsable(p, e),
      userEnabled: pref ? pref.enabled === 1 : p.defaultEnabled !== false,
      health: h ? { status: h.status, message: h.message, latencyMs: h.latency_ms, checkedAt: h.checked_at } : null,
    };
  });
}

export async function setProviderEnabled(userId: string, providerId: string, enabled: boolean) {
  if (!getProvider(providerId)) throw notFound('Provider');
  await db()
    .insertInto('provider_configurations')
    .values({ id: randomUUID(), user_id: userId, provider_id: providerId, enabled: enabled ? 1 : 0, settings: toJson({}), updated_at: nowIso() })
    .onConflict((oc) => oc.columns(['user_id', 'provider_id']).doUpdateSet({ enabled: enabled ? 1 : 0, updated_at: nowIso() }))
    .execute();
}

/** Run a provider's health check (if it has one). Never exposes credentials; records the result. */
export async function checkProviderHealth(providerId: string) {
  const p = getProvider(providerId);
  if (!p) throw notFound('Provider');
  const e = env();
  if (!isProviderUsable(p, e)) {
    const r = { status: 'not_configured', message: 'Provider is not configured or not enabled.', latencyMs: null as number | null };
    await recordProviderHealth(db(), p.id, r.status, r.message, null);
    return r;
  }
  if (!p.healthCheck) return { status: 'unknown', message: 'This provider has no health check; it is exercised during investigations.', latencyMs: null };
  // Slow providers (crt.sh: 30 s) get their own timeout plus a margin, so their own message explains a timeout.
  const timeoutMs = Math.min(45_000, Math.max(20_000, (p.timeoutMs ?? 0) + 5_000));
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  try {
    const res = await p.healthCheck({
      signal,
      env: e,
      timeoutMs,
      http: createHttpClient({ signal, userAgent: e.ATLAS_HTTP_USER_AGENT, defaultTimeoutMs: 20_000 }),
      dns: createDnsClient({ servers: e.ATLAS_DNS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean), signal }),
      now: () => new Date(),
      log: () => undefined,
    });
    await recordProviderHealth(db(), p.id, res.status, res.message, res.latencyMs ?? Date.now() - started);
    return { status: res.status, message: res.message, latencyMs: res.latencyMs ?? Date.now() - started };
  } catch (err) {
    const msg = err instanceof ProviderError ? `${err.category}: ${err.message}` : (err as Error).message;
    await recordProviderHealth(db(), p.id, 'unavailable', msg, Date.now() - started);
    return { status: 'unavailable', message: msg, latencyMs: Date.now() - started };
  }
}
