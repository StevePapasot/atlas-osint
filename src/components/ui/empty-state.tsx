import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center', className)}>
      {icon ? <div className="mb-3 rounded-full bg-surface-2 p-3 text-muted [&_svg]:h-6 [&_svg]:w-6">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger sm:flex-row sm:items-center sm:justify-between">
      <span>{message}</span>
      {retry ? (
        <button type="button" onClick={retry} className="rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium hover:bg-danger/10">
          Retry
        </button>
      ) : null}
    </div>
  );
}
