import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import { DensityToggle } from '@/components/density-toggle';
import { densityClasses, getDensity } from '@/lib/preferences';
import { LiveTimeline, ReplayTimeline } from './live-timeline';
import { ForceCancelButton } from './cancel-button';
import {
  DiscoveryDirectionsPicker,
  type DiscoveryDirection,
} from './discovery-directions-picker';

interface ToolCall {
  id: string;
  sequence: number;
  skillName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  sideEffectClass: string;
  startedAt: string;
  finishedAt: string | null;
}

interface ModelTurn {
  id: string;
  sequence: number;
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  usdEstimate: number;
  occurredAt: string;
}

interface AgentStep {
  id: string;
  agentKind: string;
  status: string;
  input: unknown;
  output: unknown;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUsdEstimate: number;
  modelTurns: ModelTurn[];
  toolCalls: ToolCall[];
}

interface Workflow {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  agentSteps: AgentStep[];
}

interface RunDetail {
  run: {
    id: string;
    status: string;
    scheduledAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    metadata: Record<string, unknown>;
  };
  workflows: Workflow[];
}

interface RunNetworkHost {
  host: string;
  attempts: number;
  allowed: number;
  blocked: number;
  firstSeen: string;
  lastSeen: string;
  reasons: string[];
  sources: string[];
  origins: string[];
  modes: string[];
}

interface RunNetworkSummary {
  runId: string;
  projectId: string;
  mode: 'enforced' | 'audit' | null;
  totals: { attempts: number; allowed: number; blocked: number };
  items: RunNetworkHost[];
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectSlug: string; runId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, projectSlug, runId } = await params;
  const sp = (await searchParams) ?? {};
  const replayMode = sp.replayMode === '1' || sp.replayMode === 'true';
  const session = await requireSession();
  const detail = await apiOr404<RunDetail>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/full`,
    { session },
  );
  const initial = await api<{ items: any[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/timeline`,
    { session },
  );

  const network = await api<RunNetworkSummary>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/network-summary`,
    { session },
  ).catch(() => null);

  const streamUrl = `/api/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/timeline/stream`;
  const totals = computeTotals(detail);
  const density = await getDensity();
  const dc = densityClasses(density);
  const canForceCancel = await hasRole(slug, session, 'admin');

  // Discovery directions picker (#507). If any agent step on this run
  // produced `output.mode === 'discovery'`, surface its directions as
  // pickable cards above the agent panel. We hide the buttons once any
  // intent exists on the project — picking creates one, so this is a
  // simple "already picked" guard.
  const discoveryDirections = extractDiscoveryDirections(detail);
  let intentsExist = false;
  if (discoveryDirections.length > 0) {
    const intents = await api<{ items: unknown[] }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/intent-inbox`,
      { session },
    ).catch(() => ({ items: [] as unknown[] }));
    intentsExist = intents.items.length > 0;
  }

  async function pickDirectionAction(formData: FormData) {
    'use server';
    const title = String(formData.get('title') ?? '').trim();
    const rationale = String(formData.get('rationale') ?? '').trim();
    if (!title) return;
    const body = rationale ? `${title}\n\n${rationale}` : title;
    const s = await requireSession();
    await api(`/v1/orgs/${slug}/projects/${projectSlug}/intent-inbox`, {
      method: 'POST',
      body: JSON.stringify({ body }),
      session: s,
    }).catch(() => undefined);
    const r = await api<{ runId: string }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/runs`,
      { method: 'POST', body: JSON.stringify({}), session: s },
    ).catch(() => null);
    if (r?.runId) {
      redirect(`/orgs/${slug}/projects/${projectSlug}/runs/${r.runId}`);
    }
    redirect(`/orgs/${slug}/projects/${projectSlug}`);
  }

  return (
    <main className={`mx-auto max-w-4xl ${dc.gapBlock} ${dc.pad}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Run</h1>
          <div className={`mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 ${dc.text} text-zinc-500`}>
            <StatusPill status={detail.run.status} />
            <span>started {detail.run.startedAt ? new Date(detail.run.startedAt).toLocaleString() : '—'}</span>
            {detail.run.finishedAt && (
              <span>· duration {fmtDuration(detail.run.startedAt, detail.run.finishedAt)}</span>
            )}
            <span>· {totals.steps} agent steps · {totals.turns} model turns · {totals.tools} tool calls</span>
            <span>· {totals.inTok.toLocaleString()} in / {totals.outTok.toLocaleString()} out tokens</span>
            {totals.usd > 0 && <span>· ${totals.usd.toFixed(4)}</span>}
            {replayMode && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                replay mode
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DensityToggle revalidate={`/orgs/${slug}/projects/${projectSlug}/runs/${runId}`} />
          {canForceCancel && (
            <ForceCancelButton
              slug={slug}
              projectSlug={projectSlug}
              runId={runId}
              status={detail.run.status}
            />
          )}
        </div>
      </header>

      {discoveryDirections.length > 0 && (
        <DiscoveryDirectionsPicker
          directions={discoveryDirections}
          action={pickDirectionAction}
          picked={intentsExist}
        />
      )}

      <AgentPanel detail={detail} />

      {network && (
        <NetworkPanel
          summary={network}
          allowlistHref={`/orgs/${slug}/projects/${projectSlug}/settings`}
        />
      )}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Each workflow runs one or more agents. Click an agent to see its input, output, and every
        model turn and tool call it made.
      </p>

      <div className="space-y-3">
        {detail.workflows.map((w) => (
          <WorkflowCard key={w.id} workflow={w} />
        ))}
      </div>

      <details>
        <summary className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          Engine timeline ({replayMode ? 'replay' : 'live'}) — raw events
        </summary>
        <Card className="mt-2">
          {replayMode ? (
            <ReplayTimeline events={initial.items} />
          ) : (
            <LiveTimeline initial={initial.items} streamUrl={streamUrl} />
          )}
        </Card>
      </details>
    </main>
  );
}

/**
 * Per-agent aggregate panel (#335). Surfaces "where did the time and
 * money go" at a glance, especially for the multi-agent careful
 * profile (planner/coder/reviewer) where the flat step list buries
 * the structure.
 *
 * Aggregates client-side from data already loaded for the page — no
 * new endpoint is needed. For legacy single-agent runs this renders
 * one card; for careful-profile runs it renders one card per kind.
 * If no agentSteps exist (still scheduling), the panel is hidden
 * entirely so the page doesn't render an empty section.
 */
function AgentPanel({ detail }: { detail: RunDetail }) {
  const byKind = new Map<
    string,
    {
      stepCount: number;
      inputTokens: number;
      outputTokens: number;
      usd: number;
      turnCount: number;
      latencyMs: number;
    }
  >();
  for (const w of detail.workflows) {
    for (const s of w.agentSteps) {
      const k = s.agentKind;
      const row = byKind.get(k) ?? {
        stepCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        turnCount: 0,
        latencyMs: 0,
      };
      row.stepCount += 1;
      row.inputTokens += s.totalInputTokens;
      row.outputTokens += s.totalOutputTokens;
      row.usd += Number(s.totalUsdEstimate ?? 0);
      row.turnCount += s.modelTurns.length;
      for (const t of s.modelTurns) row.latencyMs += t.latencyMs;
      byKind.set(k, row);
    }
  }
  if (byKind.size === 0) return null;

  // Stable canonical order: Planner, Coder, Reviewer first, then any
  // custom kinds in alpha order. So a careful-profile run reads
  // top-to-bottom matching the actual execution sequence.
  const CANONICAL = ['Planner', 'Coder', 'Reviewer'];
  const kinds = Array.from(byKind.keys()).sort((a, b) => {
    const ai = CANONICAL.indexOf(a);
    const bi = CANONICAL.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Agents ({byKind.size})
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {kinds.map((kind) => {
          const r = byKind.get(kind)!;
          return (
            <Card key={kind}>
              <div className="flex items-baseline justify-between">
                <div className="font-medium">{kind}</div>
                {r.stepCount > 1 && (
                  <span
                    className="rounded-full bg-zinc-200 px-2 py-0.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    title="Number of times this agent ran in this run — multiple rounds appear here when the reviewer requests changes (#334)"
                  >
                    {r.stepCount}×
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-y-1 text-xs text-zinc-500">
                <div>tokens</div>
                <div className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.inputTokens.toLocaleString()} in / {r.outputTokens.toLocaleString()} out
                </div>
                <div>cost</div>
                <div className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                  ${r.usd.toFixed(4)}
                </div>
                <div>model turns</div>
                <div className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.turnCount}
                </div>
                <div>wall (model)</div>
                <div className="font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                  {r.latencyMs >= 1000
                    ? `${(r.latencyMs / 1000).toFixed(1)}s`
                    : `${r.latencyMs}ms`}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Per-run network surface (#576). Renders one row per host the run
 * tried to reach (skill-level today; sandbox-level layers land later).
 * Operators use this to see at-a-glance what was *attempted* and what
 * got rejected — the only audit signal we have when traffic dies at a
 * lower layer (nftables / proxy / DNS).
 *
 * Hidden when no events were captured at all (no HTTP-bound skills ran,
 * or this is an old run from before #576 shipped); shows the explicit
 * "all outbound was allowlisted" empty state when every event was an
 * allow.
 */
function NetworkPanel({
  summary,
  allowlistHref,
}: {
  summary: RunNetworkSummary;
  allowlistHref: string;
}) {
  if (summary.totals.attempts === 0) return null;
  const allAllowed = summary.totals.blocked === 0;
  const auditOnly = summary.mode === 'audit';
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Network ({summary.items.length} {summary.items.length === 1 ? 'host' : 'hosts'})
        </h2>
        <div className="flex items-baseline gap-2 text-xs text-zinc-500">
          <span>
            {summary.totals.attempts} attempt{summary.totals.attempts === 1 ? '' : 's'} ·{' '}
            <span className="text-green-700 dark:text-green-300">
              {summary.totals.allowed} allowed
            </span>{' '}
            ·{' '}
            <span className={summary.totals.blocked > 0 ? 'text-rose-700 dark:text-rose-300' : ''}>
              {summary.totals.blocked} blocked
            </span>
          </span>
          {summary.mode && (
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                auditOnly
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
              title={
                auditOnly
                  ? 'Audit mode — these attempts were logged but not actually blocked.'
                  : 'Enforced — blocked attempts were dropped at the skill or sandbox layer.'
              }
            >
              {auditOnly ? 'audit' : 'enforced'}
            </span>
          )}
        </div>
      </div>
      {allAllowed ? (
        <Card>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            All outbound was allowlisted ✅ ·{' '}
            <Link
              href={allowlistHref}
              className="underline decoration-dotted hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              project allowlist
            </Link>
          </p>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="pb-2 pr-2 font-medium">Host</th>
                <th className="pb-2 pr-2 font-medium">Attempts</th>
                <th className="pb-2 pr-2 font-medium">Blocked</th>
                <th className="pb-2 pr-2 font-medium">Sources</th>
                <th className="pb-2 font-medium">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {summary.items.map((h) => (
                <tr
                  key={h.host}
                  className="border-t border-zinc-100 align-baseline dark:border-zinc-800"
                >
                  <td className="py-1.5 pr-2 font-mono text-zinc-800 dark:text-zinc-200">
                    {h.host}
                  </td>
                  <td className="py-1.5 pr-2 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                    {h.attempts}
                  </td>
                  <td
                    className={`py-1.5 pr-2 font-mono tabular-nums ${
                      h.blocked > 0
                        ? 'text-rose-700 dark:text-rose-300'
                        : 'text-zinc-500'
                    }`}
                  >
                    {h.blocked}
                  </td>
                  <td className="py-1.5 pr-2 text-zinc-600 dark:text-zinc-400">
                    {h.origins.length > 0
                      ? h.origins.join(', ')
                      : h.sources.join(', ')}
                  </td>
                  <td className="py-1.5 text-zinc-600 dark:text-zinc-400">
                    {h.reasons.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-500">
            Add a host to the project allowlist to unblock it ·{' '}
            <Link
              href={allowlistHref}
              className="underline decoration-dotted hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              project settings
            </Link>
          </p>
        </Card>
      )}
    </section>
  );
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const dur = fmtDuration(workflow.startedAt, workflow.finishedAt);
  const failed = workflow.status === 'failed';
  return (
    <Card>
      <details open={!failed}>
        <summary className="flex cursor-pointer list-none items-baseline justify-between">
          <div>
            <div className="font-mono text-sm font-medium">{workflow.workflowId}</div>
            <div className="text-xs text-zinc-500">{workflow.agentSteps.length} agent step(s)</div>
          </div>
          <div className="flex items-baseline gap-3 text-xs">
            <StatusPill status={workflow.status} />
            {dur && <span className="font-mono text-zinc-500">{dur}</span>}
          </div>
        </summary>
        <div className="mt-3 space-y-3 border-t pt-3 dark:border-zinc-800">
          {workflow.agentSteps.map((s) => (
            <AgentStepCard key={s.id} step={s} />
          ))}
        </div>
      </details>
    </Card>
  );
}

function AgentStepCard({ step }: { step: AgentStep }) {
  const dur = fmtDuration(step.startedAt, step.finishedAt);
  const activity = interleaveActivity(step.modelTurns, step.toolCalls);
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <details open>
        <summary className="flex cursor-pointer list-none items-baseline justify-between">
          <div>
            <div className="font-medium">{step.agentKind}</div>
            <div className="text-xs text-zinc-500">
              {step.modelTurns.length} model turn(s) · {step.toolCalls.length} tool call(s)
              · {step.totalInputTokens.toLocaleString()} in / {step.totalOutputTokens.toLocaleString()} out tokens
              {step.totalUsdEstimate > 0 && ` · $${step.totalUsdEstimate.toFixed(6)}`}
            </div>
          </div>
          <div className="flex items-baseline gap-3 text-xs">
            <StatusPill status={step.status} />
            {dur && <span className="font-mono text-zinc-500">{dur}</span>}
          </div>
        </summary>
        <div className="mt-3 space-y-3">
          {step.failureReason && (
            <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
              <strong>Failed:</strong> {step.failureReason}
            </div>
          )}

          <Section title="Input">
            <JsonBlock value={step.input} />
          </Section>

          <Section title="Output" defaultOpen>
            {step.output === null || step.output === undefined ? (
              <p className="text-sm italic text-zinc-500">No output produced.</p>
            ) : typeof step.output === 'string' ? (
              <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                {step.output}
              </pre>
            ) : (
              <JsonBlock value={step.output} />
            )}
          </Section>

          <Section title={`Activity (${activity.length})`} defaultOpen>
            {activity.length === 0 ? (
              <p className="text-sm italic text-zinc-500">No activity recorded.</p>
            ) : (
              <ol className="space-y-2">
                {activity.map((item, i) => (
                  <li key={i}>
                    {item.kind === 'turn' ? (
                      <ModelTurnRow turn={item.turn} />
                    ) : (
                      <ToolCallRow call={item.call} />
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </details>
    </div>
  );
}

function ModelTurnRow({ turn }: { turn: ModelTurn }) {
  return (
    <div className="flex items-baseline gap-3 rounded border border-dashed border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
      <span className="w-16 shrink-0 font-mono text-zinc-400">
        {new Date(turn.occurredAt).toLocaleTimeString()}
      </span>
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
        model
      </span>
      <span className="font-mono text-zinc-800 dark:text-zinc-200">{turn.modelId}</span>
      <span className="text-zinc-500">
        {turn.inputTokens.toLocaleString()} in / {turn.outputTokens.toLocaleString()} out
        {turn.cacheReadTokens > 0 && ` · ${turn.cacheReadTokens.toLocaleString()} cache`}
        {' '}· {turn.latencyMs}ms
        {turn.usdEstimate > 0 && ` · $${turn.usdEstimate.toFixed(6)}`}
      </span>
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCall }) {
  return (
    <div
      className={`rounded border px-3 py-2 text-xs ${
        call.isError
          ? 'border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-900/20'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <details>
        <summary className="flex cursor-pointer list-none items-baseline gap-3">
          <span className="w-16 shrink-0 font-mono text-zinc-400">
            {new Date(call.startedAt).toLocaleTimeString()}
          </span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
            call.isError
              ? 'bg-rose-200 text-rose-800 dark:bg-rose-800/50 dark:text-rose-200'
              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          }`}>
            tool
          </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-200">{call.skillName}</span>
          <SideEffectChip cls={call.sideEffectClass} />
          <span className="ml-auto text-zinc-500">
            {fmtDuration(call.startedAt, call.finishedAt)}
            {call.isError ? ' · errored' : ''}
          </span>
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Input</div>
            <JsonBlock value={call.input} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Output</div>
            <JsonBlock value={call.output} />
          </div>
        </div>
      </details>
    </div>
  );
}

function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details {...(defaultOpen ? { open: true } : {})}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  if (body.length > 5000) body = body.slice(0, 5000) + '\n… (truncated)';
  return (
    <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {body}
    </pre>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'done' || status === 'completed'
      ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
      : status === 'running'
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
        : status === 'failed'
          ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
          : status === 'cancelled'
            ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${tone}`}>{status}</span>
  );
}

function SideEffectChip({ cls }: { cls: string }) {
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {cls.replace(/_/g, ' ')}
    </span>
  );
}

function interleaveActivity(turns: ModelTurn[], tools: ToolCall[]) {
  const items: Array<
    | { kind: 'turn'; at: number; turn: ModelTurn }
    | { kind: 'tool'; at: number; call: ToolCall }
  > = [];
  for (const t of turns) items.push({ kind: 'turn', at: new Date(t.occurredAt).getTime(), turn: t });
  for (const c of tools) items.push({ kind: 'tool', at: new Date(c.startedAt).getTime(), call: c });
  items.sort((a, b) => a.at - b.at);
  return items;
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// Pull discovery-mode directions off whichever agent step on this run
// produced them (#492 persists `output = { mode: 'discovery', directions,
// markdown }`). Returns [] when no step ran in discovery mode — i.e. the
// run had a real seed task and the picker shouldn't render.
function extractDiscoveryDirections(d: RunDetail): DiscoveryDirection[] {
  for (const w of d.workflows) {
    for (const s of w.agentSteps) {
      const out = s.output as
        | { mode?: string; directions?: DiscoveryDirection[] }
        | null;
      if (out?.mode === 'discovery' && Array.isArray(out.directions)) {
        return out.directions;
      }
    }
  }
  return [];
}

function computeTotals(d: RunDetail) {
  let steps = 0, turns = 0, tools = 0, inTok = 0, outTok = 0, usd = 0;
  for (const w of d.workflows) {
    for (const s of w.agentSteps) {
      steps++;
      turns += s.modelTurns.length;
      tools += s.toolCalls.length;
      inTok += s.totalInputTokens;
      outTok += s.totalOutputTokens;
      usd += s.totalUsdEstimate;
    }
  }
  return { steps, turns, tools, inTok, outTok, usd };
}
