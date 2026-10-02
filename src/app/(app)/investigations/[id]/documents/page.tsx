import { Suspense } from 'react';
import { DocumentsView } from '@/components/workspace/artifacts-view';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <DocumentsView investigationId={id} />
    </Suspense>
  );
}
