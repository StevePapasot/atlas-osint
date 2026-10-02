import { Suspense } from 'react';
import { ImagesView } from '@/components/workspace/artifacts-view';

export const metadata = { title: 'Image analysis' };

export default async function ImagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ImagesView investigationId={id} />
    </Suspense>
  );
}
