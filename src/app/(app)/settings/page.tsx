import { Suspense } from 'react';
import { requireSession } from '@/server/auth/session';
import { SettingsView } from '@/components/settings/settings-view';
import { env, secretPresence, inProcessWorkerEnabled, ocrEnabled } from '@/server/config/env';
import { dialect } from '@/server/db/client';
import { aiStatus } from '@/server/ai/analysis';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const { user } = await requireSession();
  const e = env();
  const initial = {
    user: { ...user, role: user.role },
    system: {
      database: dialect(),
      worker: inProcessWorkerEnabled() ? 'in-process' : 'external',
      ocr: ocrEnabled(),
      maxUploadMb: e.ATLAS_MAX_UPLOAD_MB,
      targetFetch: e.ATLAS_ALLOW_TARGET_FETCH ?? false,
      mapTiles: Boolean(process.env.NEXT_PUBLIC_MAP_TILE_URL),
      secrets: secretPresence(),
      ai: aiStatus(),
      defaultRetentionDays: e.ATLAS_DEFAULT_RETENTION_DAYS,
    },
  };
  return (
    <Suspense>
      <SettingsView initial={JSON.parse(JSON.stringify(initial))} />
    </Suspense>
  );
}
