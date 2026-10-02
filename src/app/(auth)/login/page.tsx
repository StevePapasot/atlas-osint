import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <Suspense>
      <AuthForm mode="login" demoHint={process.env.NODE_ENV !== 'production'} />
    </Suspense>
  );
}
