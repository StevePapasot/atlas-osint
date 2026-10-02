import { Suspense } from 'react';
import { FindingsTable } from '@/components/workspace/findings-table';

export const metadata = { title: 'Findings' };

export default async function FindingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <FindingsTable investigationId={id} />
    </Suspense>
  );
}
