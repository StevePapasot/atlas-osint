'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ACTIVE_STATUSES, type InvestigationDetail } from './types';

export function useInvestigation(id: string, initial?: InvestigationDetail) {
  return useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    initialData: initial,
    refetchInterval: (q) => (q.state.data && ACTIVE_STATUSES.includes(q.state.data.status) ? 2000 : false),
  });
}

/** Poll faster while collection is running so views refresh as evidence arrives. */
export function liveInterval(status: string | undefined, ms = 3000): number | false {
  return status && ACTIVE_STATUSES.includes(status) ? ms : false;
}
