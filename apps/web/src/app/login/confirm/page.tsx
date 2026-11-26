import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Wordmark, Arrow } from '@/components/ui';
import { Mast } from '@/components/landing/mast';
import { confirmMagicLink } from './actions';

export const dynamic = 'force-dynamic';
// The URL carries a one-time token; keep it out of Referer headers.
export const metadata: Metadata = { referrer: 'no-referrer' };

/**
 * Interstitial for magic links opened in a browser that did not request
 * them (another device, or a link minted for someone else). Shows which
 * account the link signs into and only consumes the token after an
 * explicit click, so a link sent by a third party cannot silently sign
 * this browser into their account.
 */
export default async function ConfirmMagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; token?: string }>;
}) {
  const sp = await searchParams;
  if (!sp.email || !sp.token) redirect('/login?error=missing_token');

  return (
    <div className="min-h-screen bg-bg text-ink">
      <Mast />
      <main className="mx-auto max-w-md px-6 py-20">
        <Wordmark withTag />
        <h1 className="mt-10 text-[28px] font-medium tracking-[-0.025em]">Confirm sign-in</h1>
        <p className="mt-3 text-[14px] leading-[1.6] text-ink-2">
          This link signs you in to Mergecrew as <strong>{sp.email}</strong>. Continue only if this is
          your account and you requested the link.
        </p>
        <form action={confirmMagicLink} className="mt-6">
          <input type="hidden" name="email" value={sp.email} />
          <input type="hidden" name="token" value={sp.token} />
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 border border-accent bg-accent px-4 py-[12px] text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
          >
            Sign in as {sp.email} <Arrow />
          </button>
        </form>
        <p className="mt-6 text-[12.5px] text-muted">
          Not you?{' '}
          <Link href="/login" className="text-accent underline-offset-[3px] hover:underline">
            Go back to sign-in
          </Link>
        </p>
      </main>
    </div>
  );
}
