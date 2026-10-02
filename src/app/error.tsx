'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted">The error has been logged{error.digest ? ` (reference ${error.digest})` : ''}. No investigation data was lost.</p>
      <button type="button" onClick={reset} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg">
        Try again
      </button>
    </div>
  );
}
