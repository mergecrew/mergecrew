import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { api } from '@/lib/api';
import { PreOrgNav } from '@/components/pre-org-nav';
import { CreateOrgForm } from '@/components/create-org-form';
import { createOrgAction } from './orgs/new/actions';
import { Nav } from '@/components/landing/nav';
import { Mast } from '@/components/landing/mast';
import { Hero } from '@/components/landing/hero';
import { Stats } from '@/components/landing/stats';
import { Crew } from '@/components/landing/crew';
import { Loop } from '@/components/landing/loop';
import { Surfaces } from '@/components/landing/surfaces';
import { Quickstart } from '@/components/landing/quickstart';
import { Footer } from '@/components/landing/footer';

export default async function RootPage() {
  const session = await getSession();
  if (!session) return <Landing />;

  let orgs: { items: Array<{ slug: string; name: string }> } = { items: [] };
  try {
    orgs = await api<{ items: Array<{ slug: string; name: string }> }>('/v1/orgs', { session });
  } catch {
    orgs = { items: [] };
  }

  const firstSlug = orgs.items[0]?.slug;
  if (!firstSlug) return <NewOrgFlow />;
  redirect(`/orgs/${firstSlug}`);
}

function Landing() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Nav />
      <Mast />
      <Hero />
      <Stats />
      <Crew />
      <Loop />
      <Surfaces />
      <Quickstart />
      <Footer />
    </div>
  );
}

function NewOrgFlow() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <PreOrgNav />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-balance text-3xl font-medium tracking-tight sm:text-4xl">
          You&apos;re in. Let&apos;s set up your first org.
        </h1>
        <p className="mt-3 text-ink-2">
          An organization is your workspace in Mergecrew — it holds your projects, scheduled
          lifecycles, LLM provider keys, and budgets. Every org is isolated at the database level
          (Postgres row-level security), so you can safely run multiple unrelated codebases under
          one account.
        </p>
        <div className="mt-10 border border-hair bg-paper p-6 shadow-card">
          <CreateOrgForm action={createOrgAction} />
        </div>
        <section className="mt-10 border border-accent-soft bg-accent-tint p-5">
          <h2 className="m-0 font-medium">What you get next</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            <li>
              A seeded <code className="font-mono text-xs">demo-saas</code> demo project with a
              completed multi-agent run and a sample changeset.
            </li>
            <li>
              A one-click <strong>Try a sample run</strong> button on your Today page.
            </li>
            <li>
              An onboarding wizard for LLM provider → repo → deploy target → lifecycle template.
            </li>
            <li>
              Four stock lifecycle templates (<code className="font-mono text-xs">generic-careful</code>,{' '}
              <code className="font-mono text-xs">nextjs-vercel</code>,{' '}
              <code className="font-mono text-xs">python-render</code>,{' '}
              <code className="font-mono text-xs">go-fly</code>).
            </li>
          </ul>
        </section>
        <p className="mt-6 text-xs text-muted">
          Running locally with{' '}
          <code className="font-mono">docker compose up</code>? Demo mode routes every agent step
          through a deterministic stub — no LLM keys needed to see the full loop end-to-end.
        </p>
      </main>
    </div>
  );
}
