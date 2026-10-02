import { ActivityView } from '@/components/workspace/activity-view';

export const metadata = { title: 'Activity & notes' };

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ActivityView investigationId={id} />;
}
