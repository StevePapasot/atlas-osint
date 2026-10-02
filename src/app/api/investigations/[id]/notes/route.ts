import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listNotes, addNote, noteSchema } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

type P = { id: string };

export const GET = authed<P>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse({ items: await listNotes(params.id) });
});

export const POST = authed<P>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const input = await readJson(req, noteSchema);
  const id = await addNote(params.id, session.user.id, input);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'note.added', ip, targetType: 'note', targetId: id });
  return jsonResponse({ id }, { status: 201 });
});
