import { randomUUID } from 'node:crypto';
import { authed, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { buildReportSnapshot } from '@/server/reports/snapshot';
import { aiConfigured, aiErrorMessage, aiStatus, runAiAnalysis } from '@/server/ai/analysis';
import { db } from '@/server/db/client';
import { fromJson, nowIso, toJson } from '@/server/db/json';
import { recordAudit } from '@/server/audit';

type P = { id: string };

export const GET = authed<P>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const latest = await db().selectFrom('ai_analyses').selectAll().where('investigation_id', '=', params.id).orderBy('created_at', 'desc').executeTakeFirst();
  return jsonResponse({ status: aiStatus(), latest: latest ? { id: latest.id, model: latest.model, createdAt: latest.created_at, result: fromJson(latest.result, null) } : null });
});

export const POST = authed<P>(
  async ({ params, session, ip }) => {
    await getOwnedInvestigation(params.id, session.user.id);
    if (!aiConfigured()) throw new ApiError(503, 'ai_not_configured', 'AI analysis is optional and not configured. Set ANTHROPIC_API_KEY to enable it.');
    const snapshot = await buildReportSnapshot(params.id, session.user, { redact: session.user.preferences.redactExports, includeRawEvidence: false, includeAi: false });
    let result;
    try {
      result = await runAiAnalysis(snapshot);
    } catch (err) {
      throw new ApiError(502, 'ai_failed', aiErrorMessage(err));
    }
    const id = randomUUID();
    await db().insertInto('ai_analyses').values({ id, investigation_id: params.id, created_by: session.user.id, model: result.model, result: toJson(result), created_at: nowIso() }).execute();
    await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'ai.analysis', ip, metadata: { model: result.model, statements: result.summary.length, rejected: result.rejectedStatements } });
    return jsonResponse({ id, result });
  },
  { rateLimit: { bucket: 'ai', limit: 20, windowMs: 3600_000 } },
);
