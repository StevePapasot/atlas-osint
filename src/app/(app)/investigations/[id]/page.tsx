import { Overview } from '@/components/workspace/overview';

export default async function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Overview id={id} />;
}
