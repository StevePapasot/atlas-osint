import { z } from 'zod';
import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { preferencesSchema } from '@/shared/preferences';
import { updateUserPreferences, updateUserProfile, findUserById, toPublicUser } from '@/server/repositories/users';
import { env, secretPresence, inProcessWorkerEnabled, ocrEnabled } from '@/server/config/env';
import { dialect } from '@/server/db/client';
import { aiStatus } from '@/server/ai/analysis';
import { recordAudit } from '@/server/audit';

const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), preferences: preferencesSchema.partial().optional() });

function systemInfo() {
  const e = env();
  return {
    database: dialect(),
    worker: inProcessWorkerEnabled() ? 'in-process' : 'external',
    ocr: ocrEnabled(),
    maxUploadMb: e.ATLAS_MAX_UPLOAD_MB,
    targetFetch: e.ATLAS_ALLOW_TARGET_FETCH ?? false,
    mapTiles: Boolean(process.env.NEXT_PUBLIC_MAP_TILE_URL),
    secrets: secretPresence(),
    ai: aiStatus(),
    defaultRetentionDays: e.ATLAS_DEFAULT_RETENTION_DAYS,
  };
}

export const GET = authed(async ({ session }) => jsonResponse({ user: session.user, system: systemInfo() }));

export const PATCH = authed(async ({ req, session, ip }) => {
  const body = await readJson(req, patchSchema);
  if (body.name) await updateUserProfile(session.user.id, { name: body.name });
  if (body.preferences) await updateUserPreferences(session.user.id, body.preferences);
  await recordAudit({ userId: session.user.id, action: 'settings.updated', ip, metadata: { fields: [...(body.name ? ['name'] : []), ...Object.keys(body.preferences ?? {})] } });
  const user = await findUserById(session.user.id);
  return jsonResponse({ user: user ? toPublicUser(user) : null, system: systemInfo() });
});
