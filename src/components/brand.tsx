import { cn } from '@/lib/cn';

/** ATLAS mark: a globe graticule with an orbit — evokes cartography rather than "hacker" tropes. */
export function AtlasMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--accent-fg)" strokeWidth="1.6" />
      <ellipse cx="16" cy="16" rx="4" ry="9" fill="none" stroke="var(--accent-fg)" strokeWidth="1.3" />
      <path d="M7.5 13h17M7.5 19h17" stroke="var(--accent-fg)" strokeWidth="1.3" />
      <circle cx="24.5" cy="9" r="2.2" fill="var(--accent-fg)" />
    </svg>
  );
}

export function AtlasWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <AtlasMark />
      <span className="leading-none">
        <span className="block text-[15px] font-semibold tracking-[0.18em] text-fg">ATLAS</span>
        <span className="block text-[10px] font-medium tracking-[0.32em] text-muted">OSINT</span>
      </span>
    </span>
  );
}
