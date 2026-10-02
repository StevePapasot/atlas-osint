import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { deleteNote } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

export const DELETE = authed<{ id: string; noteId: string }>(async ({ params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  await deleteNote(params.id, session.user.id, params.noteId);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'note.deleted', ip, targetType: 'note', targetId: params.noteId });
  return jsonResponse({ ok: true });
});
