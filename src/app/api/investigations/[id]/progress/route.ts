import { authed, jsonResponse } from '@/server/api/handler';
import { jobProgress } from '@/server/repositories/investigations';

export const GET = authed<{ id: string }>(async ({ params, session }) => jsonResponse(await jobProgress(params.id, session.user.id)));
