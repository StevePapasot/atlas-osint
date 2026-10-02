import { EvidenceView } from '@/components/workspace/evidence-view';

export const metadata = { title: 'Evidence' };

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EvidenceView investigationId={id} />;
}
