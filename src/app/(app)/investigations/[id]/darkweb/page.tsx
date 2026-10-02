import { Suspense } from 'react';
import { DarkwebView } from '@/components/workspace/darkweb-view';

export const metadata = { title: 'Dark-web sources' };

export default async function DarkwebPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <DarkwebView investigationId={id} />
    </Suspense>
  );
}
