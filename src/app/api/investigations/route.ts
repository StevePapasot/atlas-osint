import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { createInvestigationSchema, createInvestigation, listInvestigations, startInvestigation, getInvestigationDetail } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

export const GET = authed(async ({ req, session }) => {
  const u = req.nextUrl.searchParams;
  const items = await listInvestigations(session.user.id, { status: u.get('status') ?? undefined, q: u.get('q') ?? undefined, limit: Number(u.get('limit') ?? 50), offset: Number(u.get('offset') ?? 0) });
  return jsonResponse({ items });
});

export const POST = authed(async ({ req, session, ip }) => {
  const input = await readJson(req, createInvestigationSchema);
  const id = await createInvestigation(session.user.id, input);
  await recordAudit({ userId: session.user.id, investigationId: id, action: 'investigation.created', ip, metadata: { depth: input.depth, mode: input.mode, targets: input.targets.length } });
  let jobId: string | null = null;
  if (input.start) {
    jobId = (await startInvestigation(id, session.user.id)).jobId;
    await recordAudit({ userId: session.user.id, investigationId: id, action: 'investigation.started', ip, metadata: { jobId } });
  }
  return jsonResponse({ investigation: await getInvestigationDetail(id, session.user.id), jobId }, { status: 201 });
});
