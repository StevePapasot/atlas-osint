import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { detectContradictions } from '@/server/engine/correlation';
import { db } from '@/server/db/client';
import { getProvider } from '@/server/providers/registry';

export const GET = authed<{ id: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const items = await detectContradictions(db(), params.id);
  return jsonResponse({ items: items.map((c) => ({ ...c, values: c.values.map((v) => ({ ...v, providerNames: v.providers.map((p) => getProvider(p)?.name ?? p) })) })) });
});
