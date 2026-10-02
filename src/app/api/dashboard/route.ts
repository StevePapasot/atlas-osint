import { authed, jsonResponse } from '@/server/api/handler';
import { dashboardData } from '@/server/repositories/dashboard';

export const GET = authed(async ({ session }) => jsonResponse(await dashboardData(session.user.id)));
