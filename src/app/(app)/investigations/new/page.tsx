import { requireSession } from '@/server/auth/session';
import { NewInvestigationForm } from '@/components/investigations/new-investigation-form';

export const metadata = { title: 'New investigation' };

export default async function NewInvestigationPage() {
  const { user } = await requireSession();
  return <NewInvestigationForm prefs={user.preferences} />;
}
