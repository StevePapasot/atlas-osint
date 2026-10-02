import { authed, jsonResponse } from '@/server/api/handler';

export const GET = authed(async ({ session }) => jsonResponse({ user: session.user }));
