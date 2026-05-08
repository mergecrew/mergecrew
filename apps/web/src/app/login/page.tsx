import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { isDevAutoLogin } from '@/lib/session';
import { Button } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  if (isDevAutoLogin()) redirect('/');

  return (
    <main className="mx-auto max-w-md p-12">
      <h1 className="text-2xl font-semibold">Sign in to Mergecrew</h1>
      <div className="mt-6 space-y-3">
        <form
          action={async () => {
            'use server';
            await signIn('github');
          }}
        >
          <Button variant="primary" className="w-full">Continue with GitHub</Button>
        </form>
        <form
          action={async () => {
            'use server';
            await signIn('google');
          }}
        >
          <Button variant="secondary" className="w-full">Continue with Google</Button>
        </form>
      </div>
    </main>
  );
}
