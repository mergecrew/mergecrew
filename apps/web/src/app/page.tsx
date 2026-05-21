import { redirect } from 'next/navigation';
import {
  ArrowRight,
  BookOpen,
  Bug,
  CalendarClock,
  Check,
  CircleSlash,
  ClipboardList,
  Github,
  Hammer,
  Heart,
  Layers,
  Mail,
  Map,
  MessagesSquare,
  Network,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  X as IconX,
} from 'lucide-react';
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
      <Screenshots />
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
        <nav className="flex items-center gap-1 text-sm sm:gap-3">
          <a
            href="https://github.com/mergecrew/mergecrew"
            className="hidden items-center gap-1.5 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline-flex"
          >
            <Github className="h-4 w-4" aria-hidden /> GitHub
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/README.md"
            className="hidden items-center gap-1.5 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline-flex"
          >
            <BookOpen className="h-4 w-4" aria-hidden /> Docs
          </a>
          <a
            href="https://github.com/orgs/mergecrew/projects/1"
            className="hidden items-center gap-1.5 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline-flex"
          >
            <Map className="h-4 w-4" aria-hidden /> Roadmap
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
            className="inline-flex items-center justify-center gap-1.5 rounded-md border bg-transparent px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Github className="h-4 w-4" aria-hidden /> View on GitHub
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew#quick-start"
            className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Terminal className="h-4 w-4" aria-hidden /> Self-host quick start
          </a>
        </div>
        <div className="mt-12 flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">
            <ShieldCheck className="h-3 w-3" aria-hidden /> Apache 2.0
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">
            <Layers className="h-3 w-3" aria-hidden /> Multi-tenant
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">
            <Terminal className="h-3 w-3" aria-hidden /> Self-hostable
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">
            <Sparkles className="h-3 w-3" aria-hidden /> BYO LLM keys
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-mono dark:bg-zinc-900">
            Anthropic · OpenAI · Bedrock · Ollama
          </span>
        </div>
      </div>
    </section>
  );
}

const LOOP_STEPS = [
  {
    title: 'Spec',
    body:
      "A planner agent reads recent intent, the repo, and yesterday's digest. It drafts the day's small, focused tasks.",
    Icon: ClipboardList,
    accent: 'text-sky-600 dark:text-sky-400',
  },
  {
    title: 'Build',
    body: 'Coding agents open PRs against your real branch. Every change is small, reviewable, and explainable.',
    Icon: Hammer,
    accent: 'text-amber-600 dark:text-amber-400',
  },
  {
    title: 'Deploy',
    body: 'Each PR triggers a deploy to your dev environment via a pluggable adapter (GitHub Actions or Vercel).',
    Icon: Rocket,
    accent: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    title: 'Scan',
    body: 'A bug-triage agent runs against the dev URL. Errors get filed back as the next day\'s changesets.',
    Icon: Bug,
    accent: 'text-rose-600 dark:text-rose-400',
  },
  {
    title: 'Digest',
    body: 'At end of working hours you receive a digest. You promote, defer, or roll back. Production never ships without you.',
    Icon: Mail,
    accent: 'text-violet-600 dark:text-violet-400',
  },
] as const;

const SCREENSHOTS: { src: string; alt: string; title: string; body: string }[] = [
  {
    src: '/landing/today.png',
    alt: 'Mergecrew Today dashboard with a welcome card, project list, and recent activity feed.',
    title: 'Today',
    body: 'The post-login hub. Welcome card on first visit, project list with status, recent activity from every run.',
  },
  {
    src: '/landing/timeline.png',
    alt: 'Run timeline showing Planner, Coder, and Reviewer agents with token counts, costs, and per-step input/output.',
    title: 'Live run timeline',
    body: 'Per-agent step cards stream over SSE — input, output, tool calls, token usage, cost — as the run unfolds.',
  },
  {
    src: '/landing/digest.png',
    alt: 'Daily digest page showing one changeset with Promote, Rollback, and Defer buttons.',
    title: 'Digest',
    body: "What the agents produced today, ready for one human decision. Promote, defer, or roll back — that's the gate.",
  },
  {
    src: '/landing/lifecycle.png',
    alt: 'Lifecycle configuration page with Coder, Planner, and Reviewer agents listed alongside their bound skills.',
    title: 'Lifecycle',
    body: 'Agents, workflows, custom skills, human gates — versioned mergecrew.yaml, editable from the UI or your repo.',
  },
];

function Screenshots() {
  return (
    <section className="border-t border-zinc-200/60 bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-950/50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">See it in action</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Four moments from the seeded demo project — the same surfaces you land in after{' '}
          <code className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
            docker compose up
          </code>
          .
        </p>
        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {SCREENSHOTS.map((s) => (
            <figure
              key={s.src}
              className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              {/* Use a plain <img> so this server component doesn't have
                  to thread next/image's width/height into the static
                  set — these PNGs are pre-sized desktop captures and
                  CSS resizes them for the grid. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.src}
                alt={s.alt}
                loading="lazy"
                className="block h-auto w-full border-b border-zinc-200 dark:border-zinc-800"
              />
              <figcaption className="p-4">
                <div className="font-medium">{s.title}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{s.body}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function Loop() {
  return (
    <section className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">The loop, not the agent.</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Most autonomous-coding tools take a ticket and produce a PR. Mergecrew owns the cycle around that
          work — runs it daily, deploys it, scans it, and hands you a single moment of judgment per day.
        </p>
        <ol className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {LOOP_STEPS.map((s, i) => (
            <li key={s.title} className="relative">
              <div className="h-full rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between">
                  <s.Icon className={`h-6 w-6 ${s.accent}`} aria-hidden />
                  <span className="font-mono text-xs text-zinc-400">0{i + 1}</span>
                </div>
                <div className="mt-3 text-lg font-medium">{s.title}</div>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{s.body}</p>
              </div>
              {i < LOOP_STEPS.length - 1 && (
                <ArrowRight
                  className="absolute right-0 top-1/2 hidden h-5 w-5 -translate-y-1/2 translate-x-1/2 text-zinc-300 dark:text-zinc-700 lg:block"
                  aria-hidden
                />
              )}
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

const DIFFERENTIATORS = [
  {
    title: 'Scheduled, not triggered',
    body: 'Runs on a cron against your real repo. No tickets to file, no chat to invoke. The crew shows up and does the work.',
    Icon: CalendarClock,
    accent: 'text-sky-600 dark:text-sky-400',
  },
  {
    title: 'Full lifecycle',
    body: 'Spec → design → build → deploy-to-dev → bug scan → digest → human approval → prod. Not just code generation; the whole loop.',
    Icon: Workflow,
    accent: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    title: 'Multi-tenant by design',
    body: 'Postgres row-level security, per-org budgets, per-org provider keys. Self-host privately for your team or run as a service.',
    Icon: ShieldCheck,
    accent: 'text-amber-600 dark:text-amber-400',
  },
  {
    title: 'Pluggable agents and providers',
    body: 'Anthropic, OpenAI, AWS Bedrock, or local Ollama — capability-routed with provider fallover. The bundled LangGraph runner ships by default.',
    Icon: Network,
    accent: 'text-violet-600 dark:text-violet-400',
  },
] as const;

function Differentiators() {
  return (
    <section className="border-y border-zinc-200/60 bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-950/50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">What makes Mergecrew different</h2>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {DIFFERENTIATORS.map((it) => (
            <div
              key={it.title}
              className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <it.Icon className={`h-7 w-7 ${it.accent}`} aria-hidden />
              <h3 className="mt-4 text-lg font-medium">{it.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Render a comparison cell. `yes` → green check, `no` → muted X, anything else → text. */
function Cell({ value }: { value: string }) {
  const v = value.toLowerCase();
  if (v === 'yes') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
        <Check className="h-4 w-4" aria-hidden /> yes
      </span>
    );
  }
  if (v === 'no') {
    return (
      <span className="inline-flex items-center gap-1 text-zinc-400 dark:text-zinc-500">
        <IconX className="h-4 w-4" aria-hidden /> no
      </span>
    );
  }
  if (v === 'mandatory') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
        <ShieldCheck className="h-4 w-4" aria-hidden /> mandatory
      </span>
    );
  }
  if (v === 'none' || v === 'n/a') {
    return (
      <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
        <CircleSlash className="h-4 w-4" aria-hidden /> {value}
      </span>
    );
  }
  return <span className="text-zinc-600 dark:text-zinc-400">{value}</span>;
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
          Scheduled lifecycle + multi-tenant + mandatory production gate is the combination — that&rsquo;s the whitespace.
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
                  <td className="px-3 py-3">
                    {r.us ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
                        {r.name}
                      </span>
                    ) : (
                      r.name
                    )}
                  </td>
                  <td className="px-3 py-3"><Cell value={r.trigger} /></td>
                  <td className="px-3 py-3"><Cell value={r.scope} /></td>
                  <td className="px-3 py-3"><Cell value={r.multitenant} /></td>
                  <td className="px-3 py-3"><Cell value={r.gate} /></td>
                  <td className="px-3 py-3"><Cell value={r.license} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

const STACK_TAGS: { label: string; group: 'backend' | 'frontend' | 'infra' | 'tooling' }[] = [
  { label: 'NestJS', group: 'backend' },
  { label: 'Next.js 15', group: 'frontend' },
  { label: 'Postgres + pgvector', group: 'infra' },
  { label: 'Redis', group: 'infra' },
  { label: 'BullMQ', group: 'infra' },
  { label: 'LangChain.js', group: 'backend' },
  { label: 'LangGraph.js', group: 'backend' },
  { label: 'Prisma', group: 'backend' },
  { label: 'pnpm workspaces', group: 'tooling' },
  { label: 'TypeScript', group: 'tooling' },
];

const STACK_GROUP_STYLES: Record<(typeof STACK_TAGS)[number]['group'], string> = {
  backend:
    'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700/40 dark:bg-sky-950/40 dark:text-sky-200',
  frontend:
    'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700/40 dark:bg-violet-950/40 dark:text-violet-200',
  infra:
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200',
  tooling:
    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-200',
};

function Stack() {
  return (
    <section className="border-t border-zinc-200/60 bg-zinc-50 dark:border-zinc-800/60 dark:bg-zinc-950/50">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Built on a stack you already read</h2>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          No exotic frameworks. No vendor lock-in. Every dependency is mainstream OSS.
        </p>
        <div className="mt-8 flex flex-wrap gap-2">
          {STACK_TAGS.map((t) => (
            <span
              key={t.label}
              className={`rounded-full border px-3 py-1 font-mono text-xs ${STACK_GROUP_STYLES[t.group]}`}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-4 text-[11px] text-zinc-500 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400" aria-hidden /> backend
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-violet-400" aria-hidden /> frontend
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400" aria-hidden /> infra
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" aria-hidden /> tooling
          </span>
        </div>
      </div>
    </section>
  );
}

const FINAL_CTA_HIGHLIGHTS = [
  'A seeded demo project with a completed multi-agent run',
  'No LLM keys needed — bundled stub agents drive the loop end-to-end',
  'Five-step Spec → Build → Deploy → Scan → Digest loop visible on the timeline',
];

function FinalCta() {
  return (
    <section className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Try it in five minutes</h2>
        <p className="mx-auto mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Run Mergecrew locally with a free local model — no API keys, no signup, no cloud account required.
        </p>
        <div className="mx-auto mt-8 max-w-2xl overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 text-left shadow-sm">
          <div className="flex items-center gap-2 border-b border-zinc-700 px-4 py-2 text-xs text-zinc-400">
            <Terminal className="h-3.5 w-3.5" aria-hidden /> bash
          </div>
          <pre className="overflow-x-auto p-5 text-sm text-zinc-100">
{`git clone https://github.com/mergecrew/mergecrew.git
cd mergecrew && cp .env.example .env
pnpm install && pnpm compose:up
pnpm db:migrate && pnpm db:seed
pnpm dev`}
          </pre>
        </div>
        <ul className="mx-auto mt-6 max-w-2xl space-y-2 text-left text-sm text-zinc-600 dark:text-zinc-400">
          {FINAL_CTA_HIGHLIGHTS.map((h) => (
            <li key={h} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span>{h}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LinkButton href="/login" variant="primary">Sign in</LinkButton>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/SPONSORS.md"
            className="inline-flex items-center justify-center gap-1.5 rounded-md border bg-transparent px-3 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Heart className="h-4 w-4" aria-hidden /> Sponsor the project
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const links: { href: string; label: string; Icon: typeof Github }[] = [
    { href: 'https://github.com/mergecrew/mergecrew', label: 'GitHub', Icon: Github },
    { href: 'https://github.com/mergecrew/mergecrew/blob/main/docs/README.md', label: 'Docs', Icon: BookOpen },
    { href: 'https://github.com/orgs/mergecrew/projects/1', label: 'Roadmap', Icon: Map },
    { href: 'https://github.com/mergecrew/mergecrew/discussions', label: 'Discussions', Icon: MessagesSquare },
    { href: 'https://github.com/mergecrew/mergecrew/blob/main/SPONSORS.md', label: 'Sponsors', Icon: Heart },
    { href: 'https://github.com/mergecrew/mergecrew/blob/main/SECURITY.md', label: 'Security', Icon: ShieldAlert },
  ];
  return (
    <footer className="border-t border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-6 py-10 text-sm text-zinc-500 dark:text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Mergecrew</span> · Apache 2.0
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="inline-flex items-center gap-1.5 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              <l.Icon className="h-4 w-4" aria-hidden /> {l.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
