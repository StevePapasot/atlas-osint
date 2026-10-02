/**
 * Provider configuration and connectivity report: `npm run providers:check [-- --live] [-- --json]`
 *
 * Without --live it only reports which providers are configured (from environment variables — values are never
 * printed). With --live it runs each usable provider's health check against the real service, so you can see which
 * integrations actually work from this machine and network (egress proxies, firewalls and quotas all show up here).
 */
import { db, closeDb } from '../src/server/db/client';
import { migrateToLatest } from '../src/server/db/migrate';
import { env } from '../src/server/config/env';
import { ALL_PROVIDERS, describeProvider, isProviderUsable } from '../src/server/providers/registry';
import { checkProviderHealth } from '../src/server/repositories/providers';

async function main() {
  const live = process.argv.includes('--live');
  const asJson = process.argv.includes('--json');
  const e = env();
  if (live) await migrateToLatest(db());
  const rows: Array<Record<string, unknown>> = [];
  for (const p of ALL_PROVIDERS) {
    if (p.category === 'analysis') continue;
    const d = describeProvider(p, e);
    const usable = isProviderUsable(p, e);
    const st = d.status;
    const config = st.disabledByAdmin
      ? 'disabled (admin)'
      : !st.envEnabled
        ? 'opt-in (off)'
        : st.configured
          ? st.missing.length || st.optionalMissing.length
            ? 'ready (partial)'
            : 'ready'
          : `needs ${st.missing.join(', ')}`;
    const row: Record<string, unknown> = { id: p.id, name: p.name, kind: p.kind, category: p.category, config, usable };
    if (live && usable && p.kind !== 'simulated') {
      const h = await checkProviderHealth(p.id);
      row.health = h.status;
      row.latencyMs = h.latencyMs;
      row.message = h.message;
    }
    rows.push(row);
  }
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const pad = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n);
    console.log(`${pad('provider', 26)} ${pad('kind', 10)} ${pad('configuration', 30)} ${live ? pad('health', 14) + ' message' : ''}`);
    console.log('-'.repeat(live ? 140 : 70));
    for (const r of rows) {
      console.log(`${pad(r.id, 26)} ${pad(r.kind, 10)} ${pad(r.config, 30)} ${live ? pad(r.health ?? (r.usable ? 'n/a' : '—'), 14) + ' ' + String(r.message ?? '').slice(0, 90) : ''}`);
    }
    if (!live) console.log('\nRun with --live to perform real connectivity checks for configured live providers.');
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error('[atlas] providers:check failed:', err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
