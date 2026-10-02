import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getReportSnapshot, deleteReport } from '@/server/repositories/reports';
import { renderReport, type ReportFormat } from '@/server/reports/render';
import { recordAudit } from '@/server/audit';
import { downloadResponse } from '@/server/api/download';

type P = { id: string; reportId: string };
const FORMATS = new Set<ReportFormat>(['pdf', 'markdown', 'json', 'csv']);

export const GET = authed<P>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const snapshot = await getReportSnapshot(params.id, params.reportId);
  const format = req.nextUrl.searchParams.get('format') as ReportFormat | null;
  if (!format) return jsonResponse(snapshot);
  if (!FORMATS.has(format)) return jsonResponse({ error: { code: 'bad_format', message: 'format must be pdf, markdown, json or csv.' } }, { status: 400 });
  const rendered = await renderReport(snapshot, format);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'report.downloaded', ip, targetType: 'report', targetId: params.reportId, metadata: { format } });
  return downloadResponse(rendered, snapshot.investigation.name, `report-${params.reportId.slice(0, 8)}`);
});

export const DELETE = authed<P>(async ({ params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  await deleteReport(params.id, params.reportId);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'report.deleted', ip, targetType: 'report', targetId: params.reportId });
  return jsonResponse({ ok: true });
});
