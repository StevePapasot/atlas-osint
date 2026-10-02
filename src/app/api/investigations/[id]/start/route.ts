import { authed, jsonResponse } from '@/server/api/handler';
import { startInvestigation } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

export const POST = authed<{ id: string }>(
  async ({ params, session, ip }) => {
    const r = await startInvestigation(params.id, session.user.id);
    if (!r.alreadyRunning) await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'investigation.started', ip, metadata: { jobId: r.jobId } });
    return jsonResponse(r, { status: r.alreadyRunning ? 200 : 202 });
  },
  { rateLimit: { bucket: 'start', limit: 30, windowMs: 3600_000 } },
);
