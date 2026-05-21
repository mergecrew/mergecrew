import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { signIn } from '@/auth';
import { isDevAutoLogin, SIGNED_OUT_COOKIE } from '@/lib/session';
import { Wordmark, Label, Arrow } from '@/components/ui';
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

function Mast() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-t border-ink bg-ink px-[36px] py-[10px] font-mono text-[11px] uppercase tracking-[0.1em] text-paper md:px-[80px]">
      <div className="flex flex-wrap items-center gap-x-[28px] gap-y-1">
        <span>Issue No. 142</span>
        <span>Thursday, 21 May 2026</span>
        <span>Apache 2.0</span>
      </div>
      <div className="flex items-center gap-2 text-accent-soft">
        <span className="h-[6px] w-[6px] rounded-full bg-energy animate-pulse-energy" />
        shipping its own PRs since v0.1
      </div>
    </div>
  );
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
    <div className="flex h-full flex-col gap-12 border-r border-hair bg-bg px-[40px] py-[48px] md:px-[60px] md:py-[80px]">
      <Wordmark withTag />
      <div>
        <Label className="text-accent">001 · MANIFESTO</Label>
        <h1 className="mt-4 text-[clamp(36px,4vw,56px)] font-medium leading-[1] tracking-[-0.03em]">
          The product team that doesn&apos;t need{' '}
          <em className="not-italic text-accent">standup.</em>
        </h1>
        <p className="mt-6 max-w-[540px] text-[16px] leading-[1.55] text-ink-2">
          Mergecrew is a multi-agent crew that runs on a cron against your real repository. Spec,
          build, deploy to dev, scan for regressions — every weekday by lunch. One decision arrives
          in your inbox at 5pm: promote to production, or don&apos;t.
        </p>
      </div>
      <div className="mt-auto grid grid-cols-1 gap-5 sm:grid-cols-2">
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

function OAuthRow({
  glyph,
  label,
  meta,
  action,
}: {
  glyph: string;
  label: string;
  meta: string;
  action: () => Promise<void>;
}) {
  return (
    <form action={action}>
      <button
        type="submit"
        className="group flex w-full items-center gap-3 border border-ink bg-paper px-4 py-[14px] text-left text-[14px] font-medium text-ink transition-colors hover:bg-bg"
      >
        <span className="flex h-[28px] w-[28px] items-center justify-center bg-ink font-mono text-[15px] font-bold text-paper">
          {glyph}
        </span>
        <span className="flex-1">{label}</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">{meta}</span>
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
        <LeftEditorial />
        <div className="flex items-center justify-center bg-paper px-[36px] py-[60px] md:px-[60px] md:py-[80px]">
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
                glyph="G"
                label="Continue with GitHub"
                meta="SSO · org"
                action={async () => {
                  'use server';
                  await clearSignedOutCookie();
                  await signIn('github', { redirectTo: '/' });
                }}
              />
              <OAuthRow
                glyph="g"
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
      </div>
    </div>
  );
}
