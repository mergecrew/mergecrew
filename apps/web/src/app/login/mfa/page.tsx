import { redirect } from 'next/navigation';
import { Wordmark, Arrow } from '@/components/ui';
import { Mast } from '@/components/landing/mast';
import { getPendingMfa, getSession } from '@/lib/session';
import { cancelMfaSignIn, completeMfaSignIn } from './actions';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  invalid: 'That code was not accepted. Codes work once — wait for the next one and try again.',
  locked: 'Too many incorrect codes. Wait a few minutes before trying again.',
  failed: 'We could not verify the code. Try again in a moment.',
};

/**
 * Second step of sign-in for MFA-enrolled accounts. Reached after a
 * magic-link or OAuth first factor that the API answered with
 * `mfaRequired`; no session exists until a TOTP or recovery code passes.
 */
export default async function MfaSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect('/');
  const pending = await getPendingMfa();
  if (!pending) redirect('/login');
  const sp = await searchParams;
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? ERRORS.failed) : null;

  return (
    <div className="min-h-screen bg-bg text-ink">
      <Mast />
      <main className="mx-auto max-w-md px-6 py-20">
        <Wordmark withTag />
        <h1 className="mt-10 text-[28px] font-medium tracking-[-0.025em]">Two-factor authentication</h1>
        <p className="mt-3 text-[14px] leading-[1.6] text-ink-2">
          Enter the 6-digit code from your authenticator app for{' '}
          <strong>{pending.user.email}</strong>, or one of your recovery codes.
        </p>
        <form action={completeMfaSignIn} className="mt-6 space-y-3">
          <label className="block">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">Code</span>
            <input
              type="text"
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={64}
              placeholder="123456"
              className="mt-2 h-[40px] w-full border border-hair bg-paper-2 px-3 font-mono text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
          </label>
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 border border-accent bg-accent px-4 py-[12px] text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
          >
            Verify and sign in <Arrow />
          </button>
          {errorMessage && (
            <div className="border border-energy bg-energy-soft px-3 py-2 text-[13px] text-energy-deep">
              {errorMessage}
            </div>
          )}
        </form>
        <form action={cancelMfaSignIn} className="mt-6">
          <button
            type="submit"
            className="text-[12.5px] text-accent underline-offset-[3px] hover:underline"
          >
            Cancel and use a different account
          </button>
        </form>
      </main>
    </div>
  );
}
