import { authed, jsonResponse } from '@/server/api/handler';
import { db } from '@/server/db/client';
import { fromJson } from '@/server/db/json';

export const GET = authed(async ({ session }) => {
  const rows = await db().selectFrom('audit_events').select(['id', 'action', 'investigation_id', 'target_type', 'target_id', 'metadata', 'created_at']).where('user_id', '=', session.user.id).orderBy('created_at', 'desc').limit(200).execute();
  return jsonResponse({ items: rows.map((r) => ({ ...r, metadata: fromJson(r.metadata, {}) })) });
});
