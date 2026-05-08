import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';
import { LiveTimeline } from './live-timeline';

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

export default async function RunPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; runId: string }>;
}) {
  const { slug, projectSlug, runId } = await params;
  const session = await requireSession();
  const detail = await api<RunDetail>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/full`,
    { session },
  );
  const initial = await api<{ items: any[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/timeline`,
    { session },
  );

  const streamUrl = `/api/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/timeline/stream`;
  const totals = computeTotals(detail);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Run</h1>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-zinc-500">
          <StatusPill status={detail.run.status} />
          <span>started {detail.run.startedAt ? new Date(detail.run.startedAt).toLocaleString() : '—'}</span>
          {detail.run.finishedAt && (
            <span>· duration {fmtDuration(detail.run.startedAt, detail.run.finishedAt)}</span>
          )}
          <span>· {totals.steps} agent steps · {totals.turns} model turns · {totals.tools} tool calls</span>
          <span>· {totals.inTok.toLocaleString()} in / {totals.outTok.toLocaleString()} out tokens</span>
          {totals.usd > 0 && <span>· ${totals.usd.toFixed(4)}</span>}
        </div>
      </header>

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
          Engine timeline (live) — raw events
        </summary>
        <Card className="mt-2">
          <LiveTimeline initial={initial.items} streamUrl={streamUrl} />
        </Card>
      </details>
    </main>
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
