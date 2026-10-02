'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api, ApiClientError } from '@/lib/api';

export function AuthForm({ mode, demoHint }: { mode: 'login' | 'register'; demoHint?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/api/auth/${mode}`, Object.fromEntries(form.entries()));
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to reach the server.');
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-fg">{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
      <p className="mt-1 text-sm text-muted">{mode === 'login' ? 'Investigations are private to your account.' : 'Your investigations are private by default.'}</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {mode === 'register' ? (
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" autoComplete="name" required maxLength={100} />
          </Field>
        ) : null}
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required inputMode="email" />
        </Field>
        <Field label="Password" htmlFor="password" hint={mode === 'register' ? 'At least 10 characters. Passphrases are encouraged.' : undefined}>
          <Input id="password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} />
        </Field>
        {error ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        {mode === 'login' ? (
          <>
            No account?{' '}
            <Link href="/register" className="font-medium text-accent hover:underline">
              Create one
            </Link>
          </>
        ) : (
          <>
            Already registered?{' '}
            <Link href="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
      {demoHint ? (
        <div className="mt-6 rounded-lg border border-border bg-surface-2 px-4 py-3 text-xs text-muted">
          <p className="font-medium text-fg">Local demo account</p>
          <p className="mt-1">
            Run <code className="font-mono">npm run db:seed</code> to create <span className="font-mono">demo@atlas-osint.local</span>. The password is printed by the seed script.
          </p>
        </div>
      ) : null}
    </div>
  );
}
