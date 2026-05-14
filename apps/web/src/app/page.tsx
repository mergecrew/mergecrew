import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { api } from '@/lib/api';
import { LinkButton } from '@/components/ui';
import { PreOrgNav } from '@/components/pre-org-nav';
import { CreateOrgForm } from '@/components/create-org-form';
import { createOrgAction } from './orgs/new/actions';

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

  if (!firstSlug) {
    return (
      <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <PreOrgNav />
        <main className="mx-auto max-w-3xl px-6 py-16">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            You&apos;re in. Let&apos;s set up your first org.
          </h1>
          <p className="mt-3 text-zinc-600 dark:text-zinc-400">
            An organization is your workspace in Mergecrew — it holds your projects,
            scheduled lifecycles, LLM provider keys, and budgets. Every org is isolated
            at the database level (Postgres row-level security), so you can safely run
            multiple unrelated codebases under one account.
          </p>
          <div className="mt-10 rounded-lg border bg-[rgb(var(--card))] p-6 shadow-sm">
            <CreateOrgForm action={createOrgAction} />
          </div>
          <section className="mt-10 rounded-lg border border-sky-200 bg-sky-50/50 p-5 dark:border-sky-700/40 dark:bg-sky-950/30">
            <h2 className="font-medium">What you get next</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-200">
              <li>
                A seeded <code className="font-mono text-xs">demo-saas</code> demo project with a completed multi-agent run and a sample changeset.
              </li>
              <li>
                A one-click <strong>Try a sample run</strong> button on your Today page.
              </li>
              <li>
                An onboarding wizard for LLM provider → repo → deploy target → lifecycle template.
              </li>
              <li>
                Four stock lifecycle templates (<code className="font-mono text-xs">generic-careful</code>, <code className="font-mono text-xs">nextjs-vercel</code>, <code className="font-mono text-xs">python-render</code>, <code className="font-mono text-xs">go-fly</code>).
              </li>
            </ul>
          </section>
          <p className="mt-6 text-xs text-zinc-500">
            Running locally with <code className="font-mono">docker compose up</code>? Demo mode routes every agent step through a deterministic stub — no LLM keys needed to see the full loop end-to-end.
          </p>
        </main>
      </div>
    );
  }

  redirect(`/orgs/${firstSlug}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing page (logged-out)
// ─────────────────────────────────────────────────────────────────────────────

function Landing() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Nav />
      <Hero />
      <Loop />
      <Differentiators />
      <Comparison />
      <Stack />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="border-b border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">Mergecrew</span>
          <span className="rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-orange-700 dark:border-orange-700/40 dark:bg-orange-950/40 dark:text-orange-300">
            alpha
          </span>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <a
            href="https://github.com/mergecrew/mergecrew"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            GitHub
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/README.md"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            Docs
          </a>
          <a
            href="https://github.com/orgs/mergecrew/projects/1"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            Roadmap
          </a>
          <LinkButton href="/login" variant="primary">Sign in</LinkButton>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-zinc-50 via-white to-white dark:from-zinc-900 dark:via-zinc-950 dark:to-zinc-950" />
      <div className="mx-auto max-w-4xl px-6 py-20 sm:py-28">
        <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl md:text-6xl">
          An autonomous product team that ships PRs every day.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-zinc-600 dark:text-zinc-400 md:text-xl">
          Mergecrew is the open-source platform for an{' '}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">agentic software development lifecycle</span>:
          AI agents that specify, design, build, and deploy code on a daily cadence — and stop at a human checkpoint
          before anything reaches production.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <LinkButton href="/login" variant="primary">Sign in</LinkButton>
          <a
            href="https://github.com/mergecrew/mergecrew"
            className="inline-flex items-center justify-center rounded-md border bg-transparent px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            View on GitHub →
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew#quick-start"
            className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Self-host quick start
          </a>
        </div>
        <div className="mt-12 flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-500">
          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">Apache 2.0</span>
          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">Multi-tenant</span>
          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">Self-hostable</span>
          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">BYO LLM keys</span>
          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">Anthropic · OpenAI · Bedrock · Ollama</span>
        </div>
      </div>
    </section>
  );
}

function Loop() {
  const steps: { title: string; body: string }[] = [
    { title: 'Spec', body: 'A planner agent reads recent intent, the repo, and yesterday\'s digest. It drafts the day\'s small, focused tasks.' },
    { title: 'Build', body: 'Coding agents open PRs against your real branch. Every change is small, reviewable, and explainable.' },
    { title: 'Deploy', body: 'Each PR triggers a deploy to your dev environment via a pluggable adapter (GitHub Actions or Vercel).' },
    { title: 'Scan', body: 'A bug-triage agent runs against the dev URL. Errors get filed back as the next day\'s changesets.' },
    { title: 'Digest', body: 'At end of working hours you receive a digest. You promote, defer, or roll back. Production never ships without you.' },
  ];
  return (
    <section className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">The loop, not the agent.</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Most autonomous-coding tools take a ticket and produce a PR. Mergecrew owns the cycle around that work — runs it daily, deploys it, scans it, and hands you a single moment of judgment per day.
        </p>
        <ol className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="font-mono text-xs text-zinc-400">0{i + 1}</div>
              <div className="mt-2 text-lg font-medium">{s.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-10 text-sm italic text-zinc-500">
          Production promotion is always a human decision. This is a product invariant — not a setting.
        </p>
      </div>
    </section>
  );
}

function Differentiators() {
  const items: { title: string; body: string }[] = [
    {
      title: 'Scheduled, not triggered',
      body: 'Runs on a cron against your real repo. No tickets to file, no chat to invoke. The crew shows up and does the work.',
    },
    {
      title: 'Full lifecycle',
      body: 'Spec → design → build → deploy-to-dev → bug scan → digest → human approval → prod. Not just code generation; the whole loop.',
    },
    {
      title: 'Multi-tenant by design',
      body: 'Postgres row-level security, per-org budgets, per-org provider keys. Self-host privately for your team or run as a service.',
    },
    {
      title: 'Pluggable agents and providers',
      body: 'Anthropic, OpenAI, AWS Bedrock, or local Ollama — capability-routed with provider fallover. The bundled LangGraph runner ships by default.',
    },
  ];
  return (
    <section className="bg-zinc-50 dark:bg-zinc-950/50 border-y border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">What makes Mergecrew different</h2>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {items.map((it) => (
            <div
              key={it.title}
              className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <h3 className="text-lg font-medium">{it.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Comparison() {
  const rows: { name: string; trigger: string; scope: string; multitenant: string; gate: string; license: string; us?: boolean }[] = [
    { name: 'Mergecrew', trigger: 'scheduled', scope: 'spec → deploy → digest', multitenant: 'yes', gate: 'mandatory', license: 'Apache 2.0', us: true },
    { name: 'OpenHands', trigger: 'task / chat', scope: 'code only', multitenant: 'cloud only', gate: 'optional', license: 'MIT' },
    { name: 'Aeon', trigger: 'scheduled', scope: 'code only', multitenant: 'no', gate: 'none', license: 'MIT' },
    { name: 'SWE-agent', trigger: 'issue', scope: 'code only', multitenant: 'no', gate: 'n/a', license: 'MIT' },
    { name: 'Devin / Cursor / Copilot agent', trigger: 'task / chat', scope: 'code only', multitenant: 'no', gate: 'optional', license: 'proprietary' },
  ];
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">How we compare</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Scheduled lifecycle + multi-tenant + mandatory production gate is the combination — that’s the whitespace.
        </p>
        <div className="mt-10 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Triggered by</th>
                <th className="px-3 py-2 font-medium">Lifecycle scope</th>
                <th className="px-3 py-2 font-medium">Multi-tenant</th>
                <th className="px-3 py-2 font-medium">Prod gate</th>
                <th className="px-3 py-2 font-medium">License</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.name}
                  className={
                    r.us
                      ? 'border-b border-zinc-200 bg-emerald-50/40 font-medium dark:border-zinc-800 dark:bg-emerald-950/20'
                      : 'border-b border-zinc-200 dark:border-zinc-800'
                  }
                >
                  <td className="px-3 py-3">{r.name}</td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-400">{r.trigger}</td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-400">{r.scope}</td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-400">{r.multitenant}</td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-400">{r.gate}</td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-400">{r.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Stack() {
  const tags = [
    'NestJS', 'Next.js 15', 'Postgres + pgvector', 'Redis', 'BullMQ',
    'LangChain.js', 'LangGraph.js', 'Prisma', 'pnpm workspaces', 'TypeScript',
  ];
  return (
    <section className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50 dark:bg-zinc-950/50">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Built on a stack you already read</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          No exotic frameworks. No vendor lock-in. Every dependency is mainstream OSS.
        </p>
        <div className="mt-8 flex flex-wrap gap-2">
          {tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Try it in five minutes</h2>
        <p className="mx-auto mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Run Mergecrew locally with a free local model — no API keys, no signup, no cloud account required.
        </p>
        <pre className="mx-auto mt-8 max-w-2xl overflow-x-auto rounded-lg bg-zinc-900 p-5 text-left text-sm text-zinc-100">
{`git clone https://github.com/mergecrew/mergecrew.git
cd mergecrew && cp .env.example .env
pnpm install && pnpm compose:up
pnpm db:migrate && pnpm db:seed
pnpm dev`}
        </pre>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LinkButton href="/login" variant="primary">Sign in</LinkButton>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/SPONSORS.md"
            className="inline-flex items-center justify-center rounded-md border bg-transparent px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Sponsor the project
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-6 py-10 text-sm text-zinc-500 dark:text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Mergecrew</span> · Apache 2.0
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <a href="https://github.com/mergecrew/mergecrew" className="hover:text-zinc-900 dark:hover:text-zinc-200">GitHub</a>
          <a href="https://github.com/mergecrew/mergecrew/blob/main/docs/README.md" className="hover:text-zinc-900 dark:hover:text-zinc-200">Docs</a>
          <a href="https://github.com/orgs/mergecrew/projects/1" className="hover:text-zinc-900 dark:hover:text-zinc-200">Roadmap</a>
          <a href="https://github.com/mergecrew/mergecrew/discussions" className="hover:text-zinc-900 dark:hover:text-zinc-200">Discussions</a>
          <a href="https://github.com/mergecrew/mergecrew/blob/main/SPONSORS.md" className="hover:text-zinc-900 dark:hover:text-zinc-200">Sponsors</a>
          <a href="https://github.com/mergecrew/mergecrew/blob/main/SECURITY.md" className="hover:text-zinc-900 dark:hover:text-zinc-200">Security</a>
        </div>
      </div>
    </footer>
  );
}
