import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { signIn } from '@/auth';
import { isDevAutoLogin, SIGNED_OUT_COOKIE } from '@/lib/session';
import { Button } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function clearSignedOutCookie() {
  const c = await cookies();
  c.set(SIGNED_OUT_COOKIE, '', { path: '/', maxAge: 0 });
}

export default async function LoginPage() {
  const c = await cookies();
  const manuallySignedOut = c.get(SIGNED_OUT_COOKIE)?.value === '1';

  if (isDevAutoLogin() && !manuallySignedOut) redirect('/');

  if (isDevAutoLogin() && manuallySignedOut) {
    return (
      <main className="mx-auto max-w-md p-12">
        <h1 className="text-2xl font-semibold">Signed out</h1>
        <p className="mt-2 text-sm text-zinc-500">
          You're in dev auto-login mode. Sign back in as the demo user to continue.
        </p>
        <form
          action={async () => {
            'use server';
            await clearSignedOutCookie();
            redirect('/');
          }}
          className="mt-6"
        >
          <Button variant="primary" className="w-full">
            Sign in as demo user
          </Button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-12">
      <h1 className="text-2xl font-semibold">Sign in to Mergecrew</h1>
      <div className="mt-6 space-y-3">
        <form
          action={async () => {
            'use server';
            await clearSignedOutCookie();
            await signIn('github');
          }}
        >
          <Button variant="primary" className="w-full">Continue with GitHub</Button>
        </form>
        <form
          action={async () => {
            'use server';
            await clearSignedOutCookie();
            await signIn('google');
          }}
        >
          <Button variant="secondary" className="w-full">Continue with Google</Button>
        </form>
      </div>
    </main>
  );
}
