import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listActivity } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse({ items: await listActivity(params.id) });
});
