'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { LayoutDashboard, FolderSearch, Plus, Settings, LogOut, PlugZap, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { AtlasWordmark, AtlasMark } from '@/components/brand';
import { ThemeToggle } from './theme-toggle';
import { AboutLine, type About } from './about-line';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/investigations', label: 'Investigations', icon: FolderSearch },
  { href: '/investigations/new', label: 'New investigation', icon: Plus },
  { href: '/settings?section=providers', label: 'Providers', icon: PlugZap, match: '/settings?section=providers' },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string) {
  const path = href.split('?')[0]!;
  if (path === '/investigations') return pathname === '/investigations' || (pathname.startsWith('/investigations/') && !pathname.startsWith('/investigations/new'));
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function AppShell({ user, children, theme, about }: { user: { name: string; email: string }; children: ReactNode; theme: 'system' | 'dark' | 'light'; about: About }) {
  const pathname = usePathname();
  const router = useRouter();
  async function signOut() {
    await api.post('/api/auth/logout').catch(() => undefined);
    router.replace('/login');
    router.refresh();
  }
  const initials = user.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  const userMenu = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2" aria-label="Account menu">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{initials}</span>
          <span className="hidden min-w-0 lg:block">
            <span className="block truncate text-xs font-medium text-fg">{user.name}</span>
            <span className="block truncate text-[11px] text-muted">{user.email}</span>
          </span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted lg:block" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-lg border border-border bg-elevated p-1 text-sm shadow-xl">
          <div className="px-2.5 py-2 lg:hidden">
            <p className="font-medium text-fg">{user.name}</p>
            <p className="text-xs text-muted">{user.email}</p>
          </div>
          <DropdownMenu.Item asChild>
            <Link href="/settings" className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-fg outline-none data-[highlighted]:bg-surface-2">
              <Settings className="h-4 w-4 text-muted" /> Settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void signOut()} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-fg outline-none data-[highlighted]:bg-surface-2">
            <LogOut className="h-4 w-4 text-muted" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center px-4">
          <Link href="/dashboard" aria-label="ATLAS OSINT home">
            <AtlasWordmark />
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3" aria-label="Main">
          {NAV.map((item) => {
            const active = item.match ? false : isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1.5 border-t border-border p-3 text-[11px] leading-relaxed text-subtle">
          <p>Passive, lawful collection. Coverage depends on configured providers.</p>
          <AboutLine about={about} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur lg:px-6">
          <Link href="/dashboard" className="lg:hidden" aria-label="ATLAS OSINT home">
            <span className="flex items-center gap-2">
              <AtlasMark />
              <span className="text-sm font-semibold tracking-[0.18em]">ATLAS</span>
            </span>
          </Link>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-1">
            <ThemeToggle initialTheme={theme} />
            {userMenu}
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-8 lg:pb-10">
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-surface/95 pb-safe backdrop-blur lg:hidden" aria-label="Main mobile">
        {[NAV[0]!, NAV[1]!, NAV[2]!, NAV[4]!].map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={cn('flex min-h-[56px] flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-accent' : 'text-muted')}>
              <item.icon className="h-5 w-5" />
              {item.label === 'New investigation' ? 'New' : item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
