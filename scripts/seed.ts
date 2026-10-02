/**
 * Seed a local demo account (and optionally a demo investigation): `npm run db:seed`
 *   ATLAS_DEMO_EMAIL     (default demo@atlas-osint.local)
 *   ATLAS_DEMO_PASSWORD  (default atlas-demo-2026)
 *   ATLAS_SEED_INVESTIGATION=false to skip creating the sample investigation
 */
import { closeDb, db } from '../src/server/db/client';
import { migrateToLatest } from '../src/server/db/migrate';
import { createUser, findUserByEmail } from '../src/server/repositories/users';
import { createInvestigation, startInvestigation } from '../src/server/repositories/investigations';
import { processNextJob } from '../src/server/engine/runner';

async function main() {
  await migrateToLatest(db());
  const email = process.env.ATLAS_DEMO_EMAIL ?? 'demo@atlas-osint.local';
  const password = process.env.ATLAS_DEMO_PASSWORD ?? 'atlas-demo-2026';
  let user = await findUserByEmail(email);
  if (!user) {
    user = await createUser({ email, name: 'Demo Analyst', password, role: 'admin' });
    console.log(`[atlas] created demo user ${email}`);
  } else {
    console.log(`[atlas] demo user ${email} already exists (password unchanged)`);
  }
  if (process.env.ATLAS_SEED_INVESTIGATION !== 'false') {
    const existing = await db().selectFrom('investigations').select('id').where('owner_id', '=', user.id).where('name', '=', 'Demo — Northwind Analytics (fictional)').executeTakeFirst();
    if (!existing) {
      const id = await createInvestigation(user.id, {
        name: 'Demo — Northwind Analytics (fictional)',
        description: 'Sample investigation using simulated providers and fictional identifiers.',
        scopeStatement: 'Demonstration only. All provider results are simulated; no real person or organisation is investigated.',
        depth: 'deep',
        mode: 'demo',
        modules: [],
        providers: [],
        targets: [
          { type: 'username', value: 'shadowfox_42' },
          { type: 'email', value: 'j.doe@example.org' },
          { type: 'domain', value: 'northwind-analytics.example' },
          { type: 'ip', value: '198.51.100.23' },
        ],
        start: false,
      });
      await startInvestigation(id, user.id);
      process.env.ATLAS_DEMO_FAST = process.env.ATLAS_DEMO_FAST ?? 'true';
      const status = await processNextJob(db());
      console.log(`[atlas] sample demo investigation ${id} collected (${status})`);
    }
  }
  console.log('\n  Sign in at http://localhost:3000/login');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}\n`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('[atlas] seed failed:', err);
  await closeDb();
  process.exit(1);
});
