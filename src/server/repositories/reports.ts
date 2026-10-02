import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/client';
import { fromJson, nowIso, toJson } from '../db/json';
import { notFound, ApiError } from '../api/errors';
import { buildReportSnapshot, type AiSummaryBlock, type ReportSnapshot } from '../reports/snapshot';

export const createReportSchema = z.object({
  title: z.string().trim().max(200).optional(),
  redact: z.boolean().default(false),
  includeRawEvidence: z.boolean().default(false),
  includeAi: z.boolean().default(false),
});

export async function createReport(investigationId: string, user: { id: string; name: string }, input: z.infer<typeof createReportSchema>) {
  let aiSummary: AiSummaryBlock | null = null;
  if (input.includeAi) {
    const latest = await db().selectFrom('ai_analyses').select(['result']).where('investigation_id', '=', investigationId).orderBy('created_at', 'desc').executeTakeFirst();
    if (!latest) throw new ApiError(400, 'no_ai_analysis', 'Run an AI analysis first, or generate the report without it.');
    aiSummary = fromJson<AiSummaryBlock | null>(latest.result, null);
  }
  const snapshot = await buildReportSnapshot(investigationId, user, { ...input, aiSummary });
  const id = randomUUID();
  await db()
    .insertInto('reports')
    .values({ id, investigation_id: investigationId, created_by: user.id, title: snapshot.title.slice(0, 300), snapshot: toJson(snapshot), options: toJson(input), created_at: nowIso() })
    .execute();
  return { id, snapshot };
}

export async function listReports(investigationId: string) {
  const rows = await db()
    .selectFrom('reports')
    .innerJoin('users', 'users.id', 'reports.created_by')
    .select(['reports.id', 'reports.title', 'reports.options', 'reports.created_at', 'users.name as created_by_name'])
    .where('reports.investigation_id', '=', investigationId)
    .orderBy('reports.created_at', 'desc')
    .execute();
  return rows.map((r) => ({ id: r.id, title: r.title, options: fromJson<Record<string, unknown>>(r.options, {}), createdAt: r.created_at, createdBy: r.created_by_name }));
}

export async function getReportSnapshot(investigationId: string, reportId: string): Promise<ReportSnapshot> {
  const r = await db().selectFrom('reports').select(['snapshot']).where('id', '=', reportId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!r) throw notFound('Report');
  return fromJson<ReportSnapshot>(r.snapshot, null as unknown as ReportSnapshot);
}

export async function deleteReport(investigationId: string, reportId: string) {
  const res = await db().deleteFrom('reports').where('id', '=', reportId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) throw notFound('Report');
}
