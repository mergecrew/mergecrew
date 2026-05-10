import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { signIn } from '@/auth';
import { isDevAutoLogin, SIGNED_OUT_COOKIE } from '@/lib/session';
import { Button } from '@/components/ui';
import { requestMagicLink } from './actions';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  missing_token: 'That sign-in link was incomplete. Request a new one below.',
  invalid_or_expired: 'That sign-in link is invalid or has expired. Request a new one below.',
  verify_failed: 'We could not verify the sign-in link. Try again in a moment.',
  request_failed: 'We could not send a sign-in link. Try again in a moment.',
};

async function clearSignedOutCookie() {
  const c = await cookies();
  c.set(SIGNED_OUT_COOKIE, '', { path: '/', maxAge: 0 });
}

async function sendMagicLinkAction(formData: FormData) {
  'use server';
  await clearSignedOutCookie();
  const r = await requestMagicLink(formData);
  if (r.ok) redirect(`/login?sent=${encodeURIComponent(r.email)}`);
  redirect(`/login?error=${encodeURIComponent('request_failed')}`);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const c = await cookies();
  const manuallySignedOut = c.get(SIGNED_OUT_COOKIE)?.value === '1';
  const sp = await searchParams;
  const errorMessage = sp.error ? (ERROR_MESSAGES[sp.error] ?? 'Sign-in failed.') : null;

  if (isDevAutoLogin() && !manuallySignedOut && !sp.error && !sp.sent) redirect('/');

  if (isDevAutoLogin() && manuallySignedOut && !sp.sent) {
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

  if (sp.sent) {
    return (
      <main className="mx-auto max-w-md p-12">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-zinc-500">
          We sent a sign-in link to <strong>{sp.sent}</strong>. The link expires in 15 minutes
          and works once. If you don't see it, check your spam folder.
        </p>
        <p className="mt-4 text-xs text-zinc-500">
          <a href="/login" className="underline">Use a different email</a>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-12">
      <h1 className="text-2xl font-semibold">Sign in to Mergecrew</h1>

      {errorMessage && (
        <div className="mt-4 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-900/20 dark:text-rose-200">
          {errorMessage}
        </div>
      )}

      <form action={sendMagicLinkAction} className="mt-6 space-y-2">
        <label className="block text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="mt-1 w-full rounded border px-3 py-2 dark:bg-zinc-900 dark:border-zinc-700"
          />
        </label>
        <Button variant="primary" type="submit" className="w-full">
          Email me a sign-in link
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <div className="space-y-3">
        <form
          action={async () => {
            'use server';
            await clearSignedOutCookie();
            await signIn('github');
          }}
        >
          <Button variant="secondary" className="w-full">Continue with GitHub</Button>
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
