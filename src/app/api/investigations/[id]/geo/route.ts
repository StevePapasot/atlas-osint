import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getGeoFindings } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse({ items: await getGeoFindings(params.id), tileUrl: process.env.NEXT_PUBLIC_MAP_TILE_URL ?? null });
});
