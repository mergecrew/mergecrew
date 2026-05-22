import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Activity,
  Bot,
  ClipboardList,
  Compass,
  Hammer,
  Rocket,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, PageHead } from '@/components/ui';
import { DensityToggle } from '@/components/density-toggle';
import { densityClasses, getDensity } from '@/lib/preferences';
import { LiveTimeline, ReplayTimeline } from './live-timeline';
import { ForceCancelButton } from './cancel-button';
import { DiscoveryDirectionsPicker, type DiscoveryDirection } from './discovery-directions-picker';

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
    const r = await api<{ runId: string }>(`/v1/orgs/${slug}/projects/${projectSlug}/runs`, {
      method: 'POST',
      body: JSON.stringify({}),
      session: s,
    }).catch(() => null);
    if (r?.runId) {
      redirect(`/orgs/${slug}/projects/${projectSlug}/runs/${r.runId}`);
    }
    redirect(`/orgs/${slug}/projects/${projectSlug}`);
  }

  return (
    <main className={`mx-auto max-w-[1280px] ${dc.pad}`}>
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Runs', href: `/orgs/${slug}/projects/${projectSlug}/runs` },
          { label: runId.slice(0, 8) },
        ]}
        title="Run detail"
        meta={
          <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${dc.text}`}>
            <StatusPill status={detail.run.status} />
            <span className="text-muted">
              started {detail.run.startedAt ? new Date(detail.run.startedAt).toLocaleString() : '—'}
            </span>
            {detail.run.finishedAt && (
              <span className="text-muted">
                · duration {fmtDuration(detail.run.startedAt, detail.run.finishedAt)}
              </span>
            )}
            <span className="font-mono text-muted">
              · {totals.steps} steps · {totals.turns} turns · {totals.tools} tools
            </span>
            <span className="font-mono text-muted">
              · {totals.inTok.toLocaleString()} in / {totals.outTok.toLocaleString()} out
            </span>
            {totals.usd > 0 && (
              <span className="font-mono text-ink">· ${totals.usd.toFixed(4)}</span>
            )}
            {replayMode && (
              <span className="bg-warn/20 px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink">
                replay mode
              </span>
            )}
          </div>
        }
        actions={
          <>
            <DensityToggle revalidate={`/orgs/${slug}/projects/${projectSlug}/runs/${runId}`} />
            {canForceCancel && (
              <ForceCancelButton
                slug={slug}
                projectSlug={projectSlug}
                runId={runId}
                status={detail.run.status}
              />
            )}
          </>
        }
      />

      <div className={dc.gapBlock}>
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

        <p className="text-[13px] text-ink-2">
          Each stage runs one or more agents. Click a stage to see its agents&apos; inputs, outputs,
          model turns, and tool calls. Stages run in the order the roster graph specifies —
          Discovery → PM → Implementation → QA → DeployDev → Observation.
        </p>

        <div className="space-y-3">
          {orderByStage(detail.workflows).map((w) => (
            <WorkflowCard key={w.id} workflow={w} />
          ))}
        </div>

        <details>
          <summary className="cursor-pointer text-[13px] text-muted hover:text-ink">
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
      </div>
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
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
        Agents ({byKind.size})
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {kinds.map((kind) => {
          const r = byKind.get(kind)!;
          const ic = agentIcon(kind);
          return (
            <Card key={kind}>
              <div className="flex items-baseline justify-between">
                <div className="flex items-center gap-2">
                  <ic.Icon className={`h-4 w-4 ${ic.accent}`} aria-hidden />
                  <div className="font-medium">{kind}</div>
                </div>
                {r.stepCount > 1 && (
                  <span
                    className="bg-bg-2 border border-hair px-[8px] py-[2px] font-mono text-[11px] text-ink-2 "
                    title="Number of times this agent ran in this run — multiple rounds appear here when the reviewer requests changes (#334)"
                  >
                    {r.stepCount}×
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-y-1 text-xs text-muted">
                <div>tokens</div>
                <div className="font-mono tabular-nums text-ink-2">
                  {r.inputTokens.toLocaleString()} in / {r.outputTokens.toLocaleString()} out
                </div>
                <div>cost</div>
                <div className="font-mono tabular-nums text-ink-2">${r.usd.toFixed(4)}</div>
                <div>model turns</div>
                <div className="font-mono tabular-nums text-ink-2">{r.turnCount}</div>
                <div>wall (model)</div>
                <div className="font-mono tabular-nums text-ink-2">
                  {r.latencyMs >= 1000 ? `${(r.latencyMs / 1000).toFixed(1)}s` : `${r.latencyMs}ms`}
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
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Network ({summary.items.length} {summary.items.length === 1 ? 'host' : 'hosts'})
        </h2>
        <div className="flex items-baseline gap-2 text-xs text-muted">
          <span>
            {summary.totals.attempts} attempt{summary.totals.attempts === 1 ? '' : 's'} ·{' '}
            <span className="text-green-700 dark:text-green-300">
              {summary.totals.allowed} allowed
            </span>{' '}
            ·{' '}
            <span className={summary.totals.blocked > 0 ? 'text-energy-deep' : ''}>
              {summary.totals.blocked} blocked
            </span>
          </span>
          {summary.mode && (
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                auditOnly
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-bg text-zinc-700 '
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
          <p className="text-sm text-ink-2">
            All outbound was allowlisted ✅ ·{' '}
            <Link href={allowlistHref} className="underline decoration-dotted hover:text-ink">
              project allowlist
            </Link>
          </p>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th className="pb-2 pr-2 font-medium">Host</th>
                <th className="pb-2 pr-2 font-medium">Attempts</th>
                <th className="pb-2 pr-2 font-medium">Blocked</th>
                <th className="pb-2 pr-2 font-medium">Sources</th>
                <th className="pb-2 font-medium">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {summary.items.map((h) => (
                <tr key={h.host} className="border-t border-hair-2 align-baseline ">
                  <td className="py-1.5 pr-2 font-mono text-ink">{h.host}</td>
                  <td className="py-1.5 pr-2 font-mono tabular-nums text-ink-2">{h.attempts}</td>
                  <td
                    className={`py-1.5 pr-2 font-mono tabular-nums ${
                      h.blocked > 0 ? 'text-energy-deep' : 'text-muted'
                    }`}
                  >
                    {h.blocked}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-2">
                    {h.origins.length > 0 ? h.origins.join(', ') : h.sources.join(', ')}
                  </td>
                  <td className="py-1.5 text-ink-2">{h.reasons.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            Add a host to the project allowlist to unblock it ·{' '}
            <Link href={allowlistHref} className="underline decoration-dotted hover:text-ink">
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
  // Stage-level rollup of the contained agent steps (#526): show worst-case
  // status, total cost, and per-agent kind list so the operator can read the
  // stage's health without expanding it.
  const stageStatus = rollUpStageStatus(workflow);
  const stageUsd = workflow.agentSteps.reduce((acc, s) => acc + Number(s.totalUsdEstimate ?? 0), 0);
  const stageInTok = workflow.agentSteps.reduce((acc, s) => acc + (s.totalInputTokens ?? 0), 0);
  const stageOutTok = workflow.agentSteps.reduce((acc, s) => acc + (s.totalOutputTokens ?? 0), 0);
  const agentKinds = Array.from(new Set(workflow.agentSteps.map((s) => s.agentKind)));
  const label = STAGE_LABELS[workflow.workflowId] ?? workflow.workflowId;
  const stageIcon = STAGE_ICONS[workflow.workflowId];
  return (
    <Card>
      <details open={!failed}>
        <summary className="flex cursor-pointer list-none items-baseline justify-between">
          <div className="flex items-start gap-3">
            {stageIcon && (
              <stageIcon.Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${stageIcon.accent}`}
                aria-hidden
              />
            )}
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted">
                <span className="font-mono">{workflow.workflowId}</span>
                {agentKinds.length > 0 && (
                  <>
                    {' '}
                    ·{' '}
                    {agentKinds.length === 1
                      ? agentKinds[0]
                      : `${agentKinds.length} agents (${agentKinds.join(', ')})`}
                  </>
                )}
                {' · '}
                {workflow.agentSteps.length} step{workflow.agentSteps.length === 1 ? '' : 's'}
                {(stageInTok > 0 || stageOutTok > 0) && (
                  <>
                    {' '}
                    · {stageInTok.toLocaleString()} in / {stageOutTok.toLocaleString()} out tokens
                  </>
                )}
                {stageUsd > 0 && <> · ${stageUsd.toFixed(4)}</>}
              </div>
            </div>
          </div>
          <div className="flex items-baseline gap-3 text-xs">
            <StatusPill status={stageStatus} />
            {dur && <span className="font-mono text-muted">{dur}</span>}
          </div>
        </summary>
        <div className="mt-3 space-y-3 border-t pt-3 ">
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
  const ic = agentIcon(step.agentKind);
  return (
    <div className="border border-hair p-3 ">
      <details open>
        <summary className="flex cursor-pointer list-none items-baseline justify-between">
          <div className="flex items-start gap-2">
            <ic.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${ic.accent}`} aria-hidden />
            <div>
              <div className="font-medium">{step.agentKind}</div>
              <div className="text-xs text-muted">
                {step.modelTurns.length} model turn(s) · {step.toolCalls.length} tool call(s) ·{' '}
                {step.totalInputTokens.toLocaleString()} in /{' '}
                {step.totalOutputTokens.toLocaleString()} out tokens
                {step.totalUsdEstimate > 0 && ` · $${step.totalUsdEstimate.toFixed(6)}`}
              </div>
            </div>
          </div>
          <div className="flex items-baseline gap-3 text-xs">
            <StatusPill status={step.status} />
            {dur && <span className="font-mono text-muted">{dur}</span>}
          </div>
        </summary>
        <div className="mt-3 space-y-3">
          {step.failureReason && (
            <div className="border border-energy bg-energy-soft px-3 py-2 text-[13px] text-energy-deep">
              <strong>Failed:</strong> {step.failureReason}
            </div>
          )}

          <Section title="Input">
            <JsonBlock value={step.input} />
          </Section>

          <Section title="Output" defaultOpen>
            {step.output === null || step.output === undefined ? (
              <p className="text-sm italic text-muted">No output produced.</p>
            ) : typeof step.output === 'string' ? (
              <pre className="whitespace-pre-wrap border border-hair-2 bg-bg-2 p-3 text-[13px] text-ink">
                {step.output}
              </pre>
            ) : (
              <JsonBlock value={step.output} />
            )}
          </Section>

          <Section title={`Activity (${activity.length})`} defaultOpen>
            {activity.length === 0 ? (
              <p className="text-sm italic text-muted">No activity recorded.</p>
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
    <div className="flex items-baseline gap-3 rounded border border-dashed border-hair px-3 py-1.5 text-xs ">
      <span className="w-16 shrink-0 font-mono text-muted-2">
        {new Date(turn.occurredAt).toLocaleTimeString()}
      </span>
      <span className="bg-bg border border-hair px-[6px] py-[2px] font-mono text-[10px] uppercase text-muted">
        model
      </span>
      <span className="font-mono text-ink">{turn.modelId}</span>
      <span className="text-muted">
        {turn.inputTokens.toLocaleString()} in / {turn.outputTokens.toLocaleString()} out
        {turn.cacheReadTokens > 0 && ` · ${turn.cacheReadTokens.toLocaleString()} cache`} ·{' '}
        {turn.latencyMs}ms
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
          : 'border-hair'
      }`}
    >
      <details>
        <summary className="flex cursor-pointer list-none items-baseline gap-3">
          <span className="w-16 shrink-0 font-mono text-muted-2">
            {new Date(call.startedAt).toLocaleTimeString()}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
              call.isError
                ? 'bg-rose-200 text-rose-800 dark:bg-rose-800/50 dark:text-rose-200'
                : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
            }`}
          >
            tool
          </span>
          <span className="font-mono text-ink">{call.skillName}</span>
          <SideEffectChip cls={call.sideEffectClass} />
          <span className="ml-auto text-muted">
            {fmtDuration(call.startedAt, call.finishedAt)}
            {call.isError ? ' · errored' : ''}
          </span>
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted">Input</div>
            <JsonBlock value={call.input} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted">Output</div>
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
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted hover:text-ink">
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
    <pre className="overflow-x-auto border border-hair-2 bg-bg-2 p-2 text-[11px] leading-snug text-ink-2 ">
      {body}
    </pre>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'done' || status === 'completed'
      ? 'bg-positive-soft text-positive-deep'
      : status === 'running'
        ? 'bg-accent-soft text-accent-deep'
        : status === 'failed'
          ? 'bg-energy-soft text-energy-deep'
          : status === 'cancelled'
            ? 'bg-bg-2 text-ink-2 border border-hair'
            : 'bg-bg text-ink-2 border border-hair';
  return (
    <span
      className={`px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${tone}`}
    >
      {status}
    </span>
  );
}

function SideEffectChip({ cls }: { cls: string }) {
  return (
    <span className="bg-bg px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-2 border border-hair">
      {cls.replace(/_/g, ' ')}
    </span>
  );
}

function interleaveActivity(turns: ModelTurn[], tools: ToolCall[]) {
  const items: Array<
    { kind: 'turn'; at: number; turn: ModelTurn } | { kind: 'tool'; at: number; call: ToolCall }
  > = [];
  for (const t of turns)
    items.push({ kind: 'turn', at: new Date(t.occurredAt).getTime(), turn: t });
  for (const c of tools) items.push({ kind: 'tool', at: new Date(c.startedAt).getTime(), call: c });
  items.sort((a, b) => a.at - b.at);
  return items;
}

/**
 * Canonical roster-stage ordering for the run-detail page (#526).
 * Workflows that match these ids render in the operator's mental model
 * order (Discovery → PM → … → Observation); anything else (careful-
 * legacy profile, custom YAML graphs) falls back to natural startedAt
 * order so backward-compat single-stage runs still read top-to-bottom.
 */
const STAGE_ORDER: string[] = [
  'discovery',
  'pm',
  'implementation',
  'qa',
  'deploy_dev',
  'observation',
];

const STAGE_LABELS: Record<string, string> = {
  discovery: 'Discovery',
  pm: 'Product spec',
  implementation: 'Implementation',
  qa: 'QA',
  deploy_dev: 'Deploy to dev',
  observation: 'Observation',
};

/**
 * Per-stage icon + accent. The accent palette is intentionally the same
 * one the landing's Loop section uses so the vocabulary the visitor
 * saw on `/` matches the run-detail page — Spec→sky, Build→amber,
 * Deploy→emerald, Scan→rose, etc.
 */
const STAGE_ICONS: Record<string, { Icon: LucideIcon; accent: string }> = {
  discovery: { Icon: Compass, accent: 'text-violet-600 dark:text-violet-400' },
  pm: { Icon: ClipboardList, accent: 'text-accent' },
  implementation: { Icon: Hammer, accent: 'text-ink' },
  qa: { Icon: ShieldCheck, accent: 'text-energy-deep' },
  deploy_dev: { Icon: Rocket, accent: 'text-positive-deep' },
  observation: { Icon: Activity, accent: 'text-ink-2' },
};

/**
 * Per-agent-kind icon. Used on the Agents panel + per-step cards.
 * Reviewer maps to ShieldCheck (matches the QA stage) — they share
 * the "verification" mental model.
 */
const AGENT_ICONS: Record<string, { Icon: LucideIcon; accent: string }> = {
  Planner: { Icon: ClipboardList, accent: 'text-accent' },
  Coder: { Icon: Hammer, accent: 'text-ink' },
  Reviewer: { Icon: ShieldCheck, accent: 'text-energy-deep' },
};

function agentIcon(kind: string): { Icon: LucideIcon; accent: string } {
  return AGENT_ICONS[kind] ?? { Icon: Bot, accent: 'text-ink-2' };
}

function orderByStage(workflows: Workflow[]): Workflow[] {
  const sorted = [...workflows];
  sorted.sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.workflowId);
    const bi = STAGE_ORDER.indexOf(b.workflowId);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    const at = a.startedAt ? new Date(a.startedAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.startedAt ? new Date(b.startedAt).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
  return sorted;
}

/**
 * Stage status (#526) — worst-case rollup of the contained agent
 * steps. Reflects what the operator wants to see at a glance: any
 * agent failing fails the stage; any agent still running keeps the
 * stage running; otherwise inherit the workflow's own status.
 */
function rollUpStageStatus(w: Workflow): string {
  const statuses = w.agentSteps.map((s) => s.status);
  if (statuses.some((s) => s === 'failed')) return 'failed';
  if (statuses.some((s) => s === 'running' || s === 'pending')) return 'running';
  if (statuses.length > 0 && statuses.every((s) => s === 'completed' || s === 'done')) {
    return 'completed';
  }
  return w.status;
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
      const out = s.output as { mode?: string; directions?: DiscoveryDirection[] } | null;
      if (out?.mode === 'discovery' && Array.isArray(out.directions)) {
        return out.directions;
      }
    }
  }
  return [];
}

function computeTotals(d: RunDetail) {
  let steps = 0,
    turns = 0,
    tools = 0,
    inTok = 0,
    outTok = 0,
    usd = 0;
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
