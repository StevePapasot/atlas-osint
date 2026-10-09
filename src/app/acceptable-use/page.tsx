import Link from 'next/link';
import { AtlasWordmark } from '@/components/brand';
import { ACCEPTABLE_USE, ACCEPTABLE_USE_DATE, ACCEPTABLE_USE_VERSION } from '@/shared/acceptable-use';

export const metadata = { title: 'Acceptable use' };

export default function AcceptableUsePage() {
  const p = ACCEPTABLE_USE;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
      <Link href="/" aria-label="ATLAS home">
        <AtlasWordmark />
      </Link>
      <h1 className="mt-10 text-2xl font-semibold tracking-tight text-fg">Acceptable use policy</h1>
      <p className="mt-1 text-xs text-subtle">
        Version {ACCEPTABLE_USE_VERSION} · {ACCEPTABLE_USE_DATE}
      </p>
      <div className="mt-6 space-y-8 text-sm leading-relaxed text-muted">
        <p className="text-fg">{p.intro}</p>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg">Appropriate uses include</h2>
          <ul className="list-disc space-y-1 pl-5">
            {p.appropriate.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg">You must</h2>
          <ul className="list-disc space-y-1.5 pl-5">
            {p.must.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg">You must not use ATLAS to</h2>
          <ul className="list-disc space-y-1.5 pl-5">
            {p.mustNot.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-fg">Responsibility</h2>
          <p>{p.responsibility}</p>
        </section>
      </div>
      <p className="mt-10 text-sm">
        <Link href="/register" className="font-medium text-accent hover:underline">
          Back to sign-up
        </Link>
      </p>
    </main>
  );
}
