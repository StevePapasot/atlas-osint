import { requireSession } from '@/server/auth/session';
import { dashboardData } from '@/server/repositories/dashboard';
import { DashboardView, type DashboardData } from '@/components/dashboard/dashboard-view';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const { user } = await requireSession();
  const data = (await dashboardData(user.id)) as unknown as DashboardData;
  return <DashboardView initial={JSON.parse(JSON.stringify(data))} userName={user.name} />;
}
