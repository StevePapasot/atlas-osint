import { authed, jsonResponse } from '@/server/api/handler';
import { checkProviderHealth } from '@/server/repositories/providers';

export const POST = authed<{ providerId: string }>(async ({ params }) => jsonResponse(await checkProviderHealth(params.providerId)), {
  rateLimit: { bucket: 'health', limit: 60, windowMs: 3600_000 },
});
