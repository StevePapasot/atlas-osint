import { notFound } from 'next/navigation';
import { requireSession } from '@/server/auth/session';
import { getInvestigationDetail } from '@/server/repositories/investigations';
import { ApiError } from '@/server/api/errors';
import { WorkspaceHeader } from '@/components/workspace/workspace-header';
import type { InvestigationDetail } from '@/components/workspace/types';

export default async function InvestigationLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  let detail;
  try {
    detail = await getInvestigationDetail(id, user.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  return (
    <div>
      <WorkspaceHeader initial={JSON.parse(JSON.stringify(detail)) as InvestigationDetail} />
      {children}
    </div>
  );
}
