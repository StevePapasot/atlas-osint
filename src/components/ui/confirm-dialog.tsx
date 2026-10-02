'use client';
import { useState, type ReactNode } from 'react';
import { Dialog } from './dialog';
import { Button } from './button';
import { Input } from './field';

/**
 * Confirmation for destructive actions. Optionally requires typing a phrase (e.g. the investigation name).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  requirePhrase,
  onConfirm,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  requirePhrase?: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const blocked = Boolean(requirePhrase) && typed.trim() !== requirePhrase;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} disabled={blocked} loading={loading} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requirePhrase ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted">
            Type <span className="font-mono font-semibold text-fg">{requirePhrase}</span> to confirm.
          </p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation phrase" autoFocus />
        </div>
      ) : null}
    </Dialog>
  );
}
