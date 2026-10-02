import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { buildReportSnapshot } from '@/server/reports/snapshot';
import { renderReport, type ReportFormat } from '@/server/reports/render';
import { recordAudit } from '@/server/audit';
import { downloadResponse } from '@/server/api/download';

const FORMATS = new Set<ReportFormat>(['pdf', 'markdown', 'json', 'csv']);

/** Ad-hoc export of the current investigation state (not stored as a report). */
export const GET = authed<{ id: string }>(
  async ({ req, params, session, ip }) => {
    await getOwnedInvestigation(params.id, session.user.id);
    const format = (req.nextUrl.searchParams.get('format') ?? 'json') as ReportFormat;
    if (!FORMATS.has(format)) return jsonResponse({ error: { code: 'bad_format', message: 'format must be pdf, markdown, json or csv.' } }, { status: 400 });
    const redact = req.nextUrl.searchParams.get('redact') === 'true' || session.user.preferences.redactExports;
    const snapshot = await buildReportSnapshot(params.id, session.user, { redact, includeRawEvidence: false, includeAi: false });
    const rendered = await renderReport(snapshot, format);
    await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'investigation.exported', ip, metadata: { format, redact } });
    return downloadResponse(rendered, snapshot.investigation.name, 'export');
  },
  { rateLimit: { bucket: 'export', limit: 60, windowMs: 3600_000 } },
);
