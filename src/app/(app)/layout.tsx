import { cookies } from 'next/headers';
import { requireSession } from '@/server/auth/session';
import { AppShell } from '@/components/layout/app-shell';
import { ensureWorkerStarted } from '@/server/engine/bootstrap';
import { aboutInfo } from '@/server/config/about';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  ensureWorkerStarted();
  const t = (await cookies()).get('atlas_theme')?.value;
  const theme = t === 'dark' || t === 'light' ? t : 'system';
  return (
    <AppShell user={{ name: user.name, email: user.email }} theme={theme} about={aboutInfo()}>
      {children}
    </AppShell>
  );
}
