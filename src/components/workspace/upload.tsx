'use client';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export function UploadZone({ investigationId, kind, accept, hint }: { investigationId: string; kind: 'image' | 'document'; accept: string; hint: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  async function upload(files: FileList | File[]) {
    setBusy(true);
    let ok = 0;
    for (const file of Array.from(files).slice(0, 10)) {
      const form = new FormData();
      form.set('kind', kind);
      form.set('file', file);
      try {
        await api.upload(`/api/investigations/${investigationId}/artifacts`, form);
        ok++;
      } catch (e) {
        toast({ tone: 'error', title: `Upload rejected: ${file.name}`, description: (e as Error).message });
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
    if (ok) {
      toast({ tone: 'success', title: `${ok} file(s) uploaded`, description: 'Analysis runs in the background.' });
      await qc.invalidateQueries({ queryKey: ['artifacts', investigationId] });
      await qc.invalidateQueries({ queryKey: ['investigation', investigationId] });
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
      className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors', drag ? 'border-accent bg-accent-soft/40' : 'border-border-strong bg-surface')}
    >
      <Upload className="h-6 w-6 text-subtle" aria-hidden />
      <p className="text-sm font-medium text-fg">Drop files here or choose files</p>
      <p className="max-w-md text-xs text-muted">{hint}</p>
      <input ref={input} type="file" accept={accept} multiple className="sr-only" id={`upload-${kind}`} onChange={(e) => e.target.files && void upload(e.target.files)} data-testid={`upload-${kind}`} />
      <Button asChild variant="primary" size="sm" loading={busy}>
        <label htmlFor={`upload-${kind}`} className="cursor-pointer">
          {busy ? 'Uploading…' : kind === 'image' ? 'Choose images' : 'Choose documents'}
        </label>
      </Button>
    </div>
  );
}
