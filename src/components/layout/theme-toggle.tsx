'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

type Theme = 'system' | 'dark' | 'light';

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light', 'system');
  root.classList.add(theme);
  document.cookie = `atlas_theme=${theme}; path=/; max-age=31536000; samesite=lax`;
}

export function applyDensity(density: 'comfortable' | 'compact') {
  document.documentElement.classList.toggle('density-compact', density === 'compact');
  document.cookie = `atlas_density=${density}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle({ className, initialTheme = 'system' }: { className?: string; initialTheme?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const next: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={() => {
        const t = next[theme];
        setTheme(t);
        applyTheme(t);
      }}
      className={cn('inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg', className)}
      aria-label={`Theme: ${theme}. Switch to ${next[theme]}`}
      title={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
