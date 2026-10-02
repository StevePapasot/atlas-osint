import { TimelineView } from '@/components/workspace/timeline-view';

export const metadata = { title: 'Timeline' };

export default async function TimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TimelineView investigationId={id} />;
}
