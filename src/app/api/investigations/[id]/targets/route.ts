import { z } from 'zod';
import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { addTarget, getOwnedInvestigation, targetInputSchema } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

const schema = z.object({ targets: z.array(targetInputSchema).min(1).max(50), defaultCountry: z.string().regex(/^[A-Z]{2}$/).optional() });

export const POST = authed<{ id: string }>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const body = await readJson(req, schema);
  const results = [];
  for (const t of body.targets) results.push(await addTarget(params.id, t, { defaultCountry: body.defaultCountry }));
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'targets.added', ip, metadata: { count: results.filter((r) => !r.duplicate).length } });
  return jsonResponse({ results }, { status: 201 });
});
