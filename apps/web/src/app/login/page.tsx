import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { signIn } from '@/auth';
import { isDevAutoLogin, SIGNED_OUT_COOKIE } from '@/lib/session';
import { Wordmark, Label, Arrow } from '@/components/ui';
import { Mast } from '@/components/landing/mast';
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

const FEATS = [
  {
    k: 'Cadence',
    v: (
      <>
        One run per weekday. No tickets to file, no chat to invoke.{' '}
        <b className="text-ink">The crew shows up.</b>
      </>
    ),
  },
  {
    k: 'Cost',
    v: (
      <>
        <b className="text-ink">$0.74 / run average.</b> Routed per capability with provider
        fallover on rate-limit.
      </>
    ),
  },
  {
    k: 'Human gate',
    v: (
      <>
        <b className="text-ink">One decision per day.</b> Promotion to production is an invariant,
        not a setting.
      </>
    ),
  },
  {
    k: 'Self-host',
    v: (
      <>
        Apache 2.0 · <b className="text-ink">Postgres RLS multi-tenant</b> · runs against Ollama
        with zero keys.
      </>
    ),
  },
];

function LeftEditorial() {
  return (
    <div className="flex h-full flex-col gap-8 bg-bg px-[24px] py-[32px] lg:gap-12 lg:border-r lg:border-hair lg:px-[60px] lg:py-[80px]">
      <Wordmark withTag />
      <div>
        <Label className="text-accent">001 · MANIFESTO</Label>
        <h1 className="mt-4 text-[clamp(28px,7vw,56px)] font-medium leading-[1.05] tracking-[-0.03em]">
          The product team that doesn&apos;t need{' '}
          <em className="not-italic text-accent">standup.</em>
        </h1>
        <p className="mt-5 max-w-[540px] text-[15px] leading-[1.55] text-ink-2 lg:text-[16px]">
          Mergecrew is a multi-agent crew that runs on a cron against your real repository. Spec,
          build, deploy to dev, scan for regressions — every weekday by lunch. One decision arrives
          in your inbox at 5pm: promote to production, or don&apos;t.
        </p>
      </div>
      {/* The feature grid is the bottom-half of the brand pitch — useful
          on desktop, noise on mobile where the user is already past
          the fold and just wants to sign in. */}
      <div className="mt-auto hidden grid-cols-1 gap-5 sm:grid-cols-2 lg:grid">
        {FEATS.map((f) => (
          <div key={f.k} className="border-t-2 border-ink pt-4">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{f.k}</div>
            <div className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">{f.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GithubIcon() {
  // Octocat silhouette — the same path GitHub publishes for sign-in
  // buttons under their brand guidelines. White fill against ink bg.
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden>
      <path
        fill="currentColor"
        d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11.04 11.04 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.13 0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"
      />
    </svg>
  );
}

function GoogleIcon() {
  // Google "G" mark — the four-colour path Google publishes for
  // sign-in buttons. Render at native colours regardless of theme.
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.77.42 3.44 1.18 4.95l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function OAuthRow({
  icon,
  label,
  meta,
  iconBg,
  action,
}: {
  icon: ReactNode;
  label: string;
  meta: string;
  /** Background colour for the icon square — ink for GitHub, paper for Google so the multicolour mark stays legible. */
  iconBg: 'ink' | 'paper';
  action: () => Promise<void>;
}) {
  return (
    <form action={action}>
      <button
        type="submit"
        className="group flex w-full items-center gap-3 border border-ink bg-paper px-4 py-[14px] text-left text-[14px] font-medium text-ink transition-colors hover:bg-bg"
      >
        <span
          className={
            'flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center ' +
            (iconBg === 'ink' ? 'bg-ink text-paper' : 'border border-hair bg-paper text-ink')
          }
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted sm:inline">
          {meta}
        </span>
        <Arrow />
      </button>
    </form>
  );
}

function MagicLinkForm({ errorMessage }: { errorMessage: string | null }) {
  return (
    <form action={sendMagicLinkAction} className="space-y-3">
      <label className="block">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="mt-2 h-[40px] w-full border border-hair bg-paper-2 px-3 text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />
      </label>
      <button
        type="submit"
        className="flex w-full items-center justify-center gap-2 border border-accent bg-accent px-4 py-[12px] text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
      >
        Email me a sign-in link <Arrow />
      </button>
      {errorMessage && (
        <div className="border border-energy bg-energy-soft px-3 py-2 text-[13px] text-energy-deep">
          {errorMessage}
        </div>
      )}
    </form>
  );
}

function DemoCallout() {
  const continueDemo = async () => {
    'use server';
    await clearSignedOutCookie();
    redirect('/');
  };
  return (
    <form action={continueDemo} className="border-l-[3px] border-accent bg-accent-tint px-[18px] py-[16px]">
      <div className="text-[13.5px] font-medium text-ink">
        Just exploring? Continue as the demo user.
      </div>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-2">
        Auto-login is on by default when{' '}
        <code className="font-mono text-[12px] text-ink">NODE_ENV</code> isn&apos;t{' '}
        <code className="font-mono text-[12px] text-ink">production</code> — set{' '}
        <code className="font-mono text-[12px] text-ink">MERGECREW_DEV_AUTO_LOGIN=false</code> to
        require OAuth locally.
      </p>
      <button
        type="submit"
        className="mt-3 flex w-full items-center justify-between border border-accent bg-paper px-3 py-[8px] text-[13px] text-accent-deep transition-colors hover:bg-accent hover:text-paper"
      >
        <span>continue as demo@mergecrew.local</span>
        <Arrow />
      </button>
    </form>
  );
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

  if (sp.sent) {
    return (
      <div className="min-h-screen bg-bg text-ink">
        <Mast />
        <main className="mx-auto max-w-md px-6 py-20">
          <Wordmark withTag />
          <h1 className="mt-10 text-[28px] font-medium tracking-[-0.025em]">Check your email</h1>
          <p className="mt-3 text-[14px] leading-[1.6] text-ink-2">
            We sent a sign-in link to <strong>{sp.sent}</strong>. The link expires in 15 minutes
            and works once. If you don&apos;t see it, check your spam folder.
          </p>
          <p className="mt-6 text-[12.5px] text-muted">
            <Link href="/login" className="text-accent underline-offset-[3px] hover:underline">
              Use a different email
            </Link>
          </p>
        </main>
      </div>
    );
  }

  if (isDevAutoLogin() && manuallySignedOut) {
    return (
      <div className="min-h-screen bg-bg text-ink">
        <Mast />
        <main className="mx-auto max-w-md px-6 py-20">
          <Wordmark withTag />
          <h1 className="mt-10 text-[28px] font-medium tracking-[-0.025em]">Signed out</h1>
          <p className="mt-3 text-[14px] leading-[1.6] text-ink-2">
            You&apos;re in dev auto-login mode. Sign back in as the demo user to continue.
          </p>
          <form
            action={async () => {
              'use server';
              await clearSignedOutCookie();
              redirect('/');
            }}
            className="mt-6"
          >
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 border border-accent bg-accent px-4 py-[12px] text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
            >
              Sign in as demo user <Arrow />
            </button>
          </form>
        </main>
      </div>
    );
  }

  const showDemoCallout = isDevAutoLogin();

  return (
    <div className="min-h-screen bg-bg text-ink">
      <Mast />
      <div className="grid min-h-[calc(100vh-44px)] grid-cols-1 lg:grid-cols-2">
        {/* OAuth form is order-1 on mobile so visitors see "Welcome
            back" + GitHub / Google buttons above the fold without
            scrolling past the editorial column. On lg+, the
            editorial column reclaims the left side. */}
        <div className="order-1 flex items-center justify-center bg-paper px-[24px] py-[40px] lg:order-2 lg:px-[60px] lg:py-[80px]">
          <div className="w-full max-w-[440px]">
            <Label accent>SIGN IN · 002</Label>
            <h2 className="mt-3 text-[32px] font-medium leading-[1.1] tracking-[-0.025em]">
              Welcome back.
            </h2>
            <p className="mt-3 text-[14px] leading-[1.55] text-ink-2">
              Pick a provider. We don&apos;t store passwords — auth is delegated to GitHub or
              Google.
            </p>
            <div className="mt-7 space-y-3">
              <OAuthRow
                icon={<GithubIcon />}
                iconBg="ink"
                label="Continue with GitHub"
                meta="SSO · org"
                action={async () => {
                  'use server';
                  await clearSignedOutCookie();
                  await signIn('github', { redirectTo: '/' });
                }}
              />
              <OAuthRow
                icon={<GoogleIcon />}
                iconBg="paper"
                label="Continue with Google"
                meta="Workspace"
                action={async () => {
                  'use server';
                  await clearSignedOutCookie();
                  await signIn('google', { redirectTo: '/' });
                }}
              />
            </div>
            <div className="my-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              <span className="h-px flex-1 bg-hair-2" />
              or
              <span className="h-px flex-1 bg-hair-2" />
            </div>
            <MagicLinkForm errorMessage={errorMessage} />
            {showDemoCallout && (
              <div className="mt-6">
                <DemoCallout />
              </div>
            )}
            <p className="mt-8 text-[12px] leading-[1.6] text-muted">
              By signing in, you agree to the{' '}
              <Link
                href="https://github.com/mergecrew/mergecrew/blob/main/CODE_OF_CONDUCT.md"
                className="underline-offset-[3px] hover:underline"
              >
                code of conduct
              </Link>
              . Mergecrew is in <b className="text-ink">alpha</b> — not yet recommended for
              production tenants.
            </p>
          </div>
        </div>
        <div className="order-2 lg:order-1">
          <LeftEditorial />
        </div>
      </div>
    </div>
  );
}
