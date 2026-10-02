import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/server/auth/session';
import { AtlasWordmark } from '@/components/brand';
import { ShieldCheck, Network, FileSearch } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentSession()) redirect('/dashboard');
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(var(--fg)_1px,transparent_1px),linear-gradient(90deg,var(--fg)_1px,transparent_1px)] [background-size:44px_44px]" />
        <AtlasWordmark className="relative" />
        <div className="relative max-w-md space-y-8">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-fg">Evidence-first open-source intelligence.</h1>
          <ul className="space-y-5 text-sm text-muted">
            <li className="flex gap-3">
              <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <span>Every finding keeps its source, collection time, evidence hash and confidence rationale.</span>
            </li>
            <li className="flex gap-3">
              <Network className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <span>Relationships are candidates until an analyst confirms them. Nothing is merged automatically.</span>
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <span>Passive, lawful collection by default. Provider coverage and failures are always disclosed.</span>
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-subtle">For authorised research, defensive security and lawful investigations only.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <AtlasWordmark />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
