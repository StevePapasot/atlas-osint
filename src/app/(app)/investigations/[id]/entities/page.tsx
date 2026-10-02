import { Suspense } from 'react';
import { EntitiesView } from '@/components/workspace/entities-view';

export const metadata = { title: 'Entities' };

export default async function EntitiesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <EntitiesView investigationId={id} />
    </Suspense>
  );
}
