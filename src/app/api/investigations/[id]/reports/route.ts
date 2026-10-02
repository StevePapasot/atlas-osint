import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { createReport, createReportSchema, listReports } from '@/server/repositories/reports';
import { recordAudit } from '@/server/audit';

type P = { id: string };

export const GET = authed<P>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse({ items: await listReports(params.id) });
});

export const POST = authed<P>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const input = await readJson(req, createReportSchema);
  const r = await createReport(params.id, session.user, input);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'report.generated', ip, targetType: 'report', targetId: r.id, metadata: { redact: input.redact, includeAi: input.includeAi } });
  return jsonResponse({ id: r.id, title: r.snapshot.title, stats: r.snapshot.stats }, { status: 201 });
});
