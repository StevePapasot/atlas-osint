import { authed, jsonResponse } from '@/server/api/handler';
import { listProvidersForUser } from '@/server/repositories/providers';
import { secretPresence } from '@/server/config/env';
import { aiStatus } from '@/server/ai/analysis';

export const GET = authed(async ({ session }) => jsonResponse({ items: await listProvidersForUser(session.user.id), secrets: secretPresence(), ai: aiStatus() }));
