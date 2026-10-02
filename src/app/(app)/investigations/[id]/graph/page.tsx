import { GraphView } from '@/components/workspace/graph-view';

export const metadata = { title: 'Relationship graph' };

export default async function GraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GraphView investigationId={id} />;
}
