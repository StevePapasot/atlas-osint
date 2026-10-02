import { ReportsView } from '@/components/workspace/reports-view';

export const metadata = { title: 'Reports' };

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReportsView investigationId={id} />;
}
