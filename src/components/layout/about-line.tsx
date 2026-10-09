import { cn } from '@/lib/cn';

export interface About {
  version: string;
  license: string;
  sourceUrl: string;
}

/** "ATLAS OSINT v0.1.0 · AGPL-3.0 · Source code" — the source link is required by the AGPL for network use. */
export function AboutLine({ about, className }: { about: About; className?: string }) {
  return (
    <p className={cn('text-[11px] text-subtle', className)}>
      ATLAS OSINT v{about.version} ·{' '}
      <a href="/acceptable-use" className="hover:text-fg hover:underline">
        Acceptable use
      </a>{' '}
      ·{' '}
      <a href={about.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:text-fg hover:underline">
        Source code ({about.license})
      </a>
    </p>
  );
}
