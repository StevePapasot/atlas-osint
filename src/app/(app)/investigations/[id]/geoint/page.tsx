import { GeointView } from '@/components/workspace/geoint-view';

export const metadata = { title: 'GEOINT' };

export default async function GeointPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GeointView investigationId={id} />;
}
