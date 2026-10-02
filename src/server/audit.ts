import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from './db/client';
import { nowIso, toJson } from './db/json';
import { hashIp } from './security/hash';
import { redactObject } from './security/redact';
import { logger } from './logging/logger';

export interface AuditInput {
  userId: string | null;
  action: string;
  investigationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db()
      .insertInto('audit_events')
      .values({
        id: randomUUID(),
        user_id: input.userId,
        investigation_id: input.investigationId ?? null,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        metadata: toJson(redactObject(input.metadata ?? {})),
        ip_hash: hashIp(input.ip),
        created_at: nowIso(),
      })
      .execute();
  } catch (err) {
    // Audit failures must be visible but must not break the user action.
    logger.error('audit write failed', { action: input.action, error: err instanceof Error ? err.message : String(err) });
  }
}
