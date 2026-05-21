import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import type { Eventlog } from '@mergecrew/eventlog';
import type { GraphDefinition, MergecrewConfig } from '@mergecrew/domain';
import {
  CAREFUL_GRAPH,
  ROSTER_GRAPH,
  GRAPH_END,
  findGraphEntryNode,
  findNextGraphNode,
  getNodeAgents,
  newRunIdForDate,
  parseAndValidateGraphYaml,
  resolveAgentByRef,
  shortId,
} from '@mergecrew/domain';

// Mirrors agent-runtime's exported kind constants. Inlined here (rather
// than imported from `@mergecrew/agent-runtime`) so the orchestrator
// doesn't pull the langgraph runtime into its dependency tree just to
// branch on a handful of string literals.
const REVIEWER_KIND = 'Reviewer';
const CODER_KIND = 'Coder';
const PLANNER_KIND = 'Planner';
// Roster kinds the dispatcher routes on (#516, V2.af). The full
// catalog lives in `@mergecrew/agent-runtime`; only the kinds whose
// outputs the orchestrator switches on (or whose loop caps it counts)
// need a constant here.
const DISCOVERY_KIND = 'Discovery';
const QA_KIND = 'QA';
const PM_KIND = 'PM';
import { emailEnabledFromEnv } from '@mergecrew/adapters-comms';
import { syncLifecycleFromRepo } from './lifecycle-sync.js';
import { dispatchSlackDigest } from './digest-slack.js';
import { dispatchEmailDigest } from './digest-email.js';
import { handleSlackInteractivity } from './slack-interactivity.js';
import { handleSentryWebhook } from './sentry-webhook.js';
import { telemetry } from './telemetry.js';

interface OrchestratorDeps {
  connection: Redis;
  eventlog: Eventlog;
  logger: Logger;
}

export class Orchestrator {
  private runner: Queue;
  private wake: Queue;
  private digestSlack: Queue;
  private digestEmail: Queue;
  private orgCapWaitQueue: Queue;
  private workspaceCleanupQueue: Queue;

  private dispatchQueue: Queue;

  constructor(private deps: OrchestratorDeps) {
    this.runner = new Queue('runner.step', { connection: deps.connection });
    this.wake = new Queue('orchestrator.rate-limit.resume', { connection: deps.connection });
    this.digestSlack = new Queue('digest.slack', { connection: deps.connection });
    this.digestEmail = new Queue('digest.email', { connection: deps.connection });
    this.dispatchQueue = new Queue('orchestrator.dispatch', { connection: deps.connection });
    this.orgCapWaitQueue = new Queue('orchestrator.org-cap-wait', { connection: deps.connection });
    this.workspaceCleanupQueue = new Queue('runner.workspace-cleanup', { connection: deps.connection });
  }

  // ─── 1. Run start ───────────────────────────────────────────────────────

  async handleRunDue(data: {
    organizationId: string;
    projectId: string;
    /**
     * When the API pre-created a pending DailyRun (#407, V2.aj), it
     * passes the row's id here. The handler flips it pending → running
     * instead of creating a new row, so the API can hand the operator
     * a runId to redirect to immediately. Unset for cron-scheduled
     * runs and any legacy enqueue path; the handler keeps creating its
     * own row in that case.
     */
    runId?: string;
    manual?: boolean;
  }): Promise<void> {
    const { organizationId, projectId } = data;

    // Operator kill switch (#625), defensive check. Pause could have
    // flipped on between the API enqueue and this dispatch — the cron
    // tick and runNow both check first, but a queued job that arrives
    // mid-pause must not burn LLM tokens *or* a GitHub API call against
    // the rate-limit window. Check happens before the
    // `syncLifecycleFromRepo` call below so a paused project doesn't
    // waste a GitHub request (#639).
    const project = await withTenant(organizationId, (tx) =>
      tx.project.findUnique({
        where: { id: projectId },
        include: {
          organization: { select: { runsPausedAt: true, runsPauseReason: true } },
        },
      }),
    );
    if (!project) return;
    if (project.organization.runsPausedAt || project.runsPausedAt) {
      const scope = project.organization.runsPausedAt ? 'org' : 'project';
      const reason =
        project.organization.runsPausedAt
          ? project.organization.runsPauseReason
          : project.runsPauseReason;
      this.deps.logger.warn(
        { projectId, projectSlug: project.slug, scope, reason },
        'run.due aborted: runs paused',
      );
      if (data.runId) {
        await withTenant(organizationId, (tx) =>
          tx.dailyRun.update({
            where: { id: data.runId! },
            data: {
              status: 'cancelled',
              finishedAt: new Date(),
              metadata: { manual: !!data.manual, cancelReason: 'paused', pauseScope: scope },
            },
          }),
        );
        await this.deps.eventlog.emit({
          organizationId,
          projectId,
          dailyRunId: data.runId,
          type: 'RUN_CANCELLED',
          actor: { kind: 'system' },
          payload: { reason: 'paused', scope },
        });
      }
      return;
    }

    // Pull the project's mergecrew.yaml from its repo and persist a new
    // Lifecycle version if it changed. Best-effort — failures fall through
    // to whatever lifecycle version is already in the DB. Done AFTER the
    // pause check so a paused project doesn't waste the GitHub call.
    await syncLifecycleFromRepo({
      organizationId,
      projectId,
      logger: this.deps.logger,
    }).catch((err) => {
      this.deps.logger.warn({ err: err?.message ?? err, projectId }, 'lifecycle-sync: unexpected error');
    });

    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
    );
    if (!lc) {
      // Defensive: the API (RunService.runNow) and the cron tick both
      // refuse to enqueue when there's no lifecycle, so reaching this
      // branch means either a hand-enqueued job or a race where the
      // lifecycle was deleted between the precondition check and here.
      // Log with the project slug so the operator can grep for it.
      this.deps.logger.warn(
        { projectId, projectSlug: project.slug },
        'run.due aborted: project has no lifecycle (save mergecrew.yaml from the Lifecycle page to enable runs)',
      );
      return;
    }

    // If the API pre-created a pending DailyRun, that row IS this
    // run — pick it up rather than treating it as an inflight blocker.
    // Otherwise apply the usual "one run at a time per project" guard.
    let run: { id: string; projectId: string; status: string } | null = null;
    if (data.runId) {
      const preCreated = await withTenant(organizationId, (tx) =>
        tx.dailyRun.findUnique({ where: { id: data.runId! } }),
      );
      if (preCreated && preCreated.status === 'pending') {
        run = await withTenant(organizationId, (tx) =>
          tx.dailyRun.update({
            where: { id: preCreated.id },
            data: { status: 'running', startedAt: new Date() },
          }),
        );
      } else if (preCreated) {
        this.deps.logger.info(
          { runId: preCreated.id, status: preCreated.status },
          'run.due: pre-created run already advanced; skipping',
        );
        return;
      }
    }

    if (!run) {
      const inflight = await withTenant(organizationId, (tx) =>
        tx.dailyRun.findFirst({
          where: { projectId, status: { in: ['pending', 'running', 'paused_rate_limit', 'paused_gate'] } },
          orderBy: { scheduledAt: 'desc' },
        }),
      );
      if (inflight) {
        this.deps.logger.info({ runId: inflight.id }, 'run already in flight; skipping');
        return;
      }

      run = await withTenant(organizationId, (tx) =>
        tx.dailyRun.create({
          data: {
            organizationId,
            projectId,
            lifecycleId: lc.id,
            scheduledAt: new Date(),
            status: 'running',
            startedAt: new Date(),
            metadata: { manual: !!data.manual },
          },
        }),
      );
    }
    await withTenant(organizationId, (tx) =>
      tx.dailyRun.update({ where: { id: run.id }, data: { id: run.id } }), // no-op; placeholder
    );

    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: run.id,
      type: 'RUN_STARTED',
      actor: { kind: 'system' },
      payload: { manual: !!data.manual, lifecycleVersion: lc.version },
    });

    const cfg = lc.parsed as MergecrewConfig;
    const first = cfg.lifecycle.workflows[0];
    if (!first) return;
    await this.startWorkflow(organizationId, projectId, run.id, first.id);
  }

  // ─── 2. Workflow / step dispatch ────────────────────────────────────────

  async startWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowId: string,
    parentWorkflowRunId?: string,
  ): Promise<string> {
    const wfr = await withTenant(organizationId, (tx) =>
      tx.workflowRun.create({
        data: {
          organizationId,
          dailyRunId: runId,
          workflowId,
          parentWorkflowRunId: parentWorkflowRunId ?? null,
          status: 'running',
          startedAt: new Date(),
        },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId: wfr.id,
      type: 'WORKFLOW_STARTED',
      actor: { kind: 'system' },
      payload: { workflowId },
    });

    // Dispatch one step per agent. The workflow's parsed config is fetched via the daily run's lifecycle.
    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
      }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    const wf = cfg.lifecycle?.workflows?.find((w) => w.id === workflowId);
    if (!wf) {
      await this.completeWorkflow(organizationId, projectId, runId, wfr.id, 'no-such-workflow');
      return wfr.id;
    }

    // Graph-profile dispatch (#348, #350). For careful or custom-profile
    // projects, ignore the parallel `wf.agents` fan-out and chain through
    // the resolved GraphDefinition: dispatch the entry node only; each
    // step's completion drives the next (`onStepReply` calls
    // `dispatchGraphNext`). Operator-defined Planner/Coder/Reviewer
    // agents in `mergecrew.yaml` override the stock fallback by sharing
    // the same agentRef.
    const project = await withTenant(organizationId, (tx) =>
      tx.project.findUnique({
        where: { id: projectId },
        select: { graphProfile: true, graphYaml: true },
      }),
    );
    const graph = this.resolveProjectGraph(project, cfg, { runId, workflowRunId: wfr.id });
    if (graph) {
      await this.dispatchGraphEntry(organizationId, projectId, runId, wfr.id, cfg, graph);
      return wfr.id;
    }

    for (const agentRef of wf.agents) {
      await this.dispatchAgentStep(organizationId, projectId, runId, wfr.id, agentRef, cfg);
    }
    return wfr.id;
  }

  /**
   * Resolve the project's effective graph definition from its
   * `graphProfile` + (for custom) `graphYaml`. Returns null for the
   * legacy `fast` profile so the caller falls back to the parallel
   * `wf.agents` dispatch.
   *
   * Custom YAML is re-parsed on each call (cheap — the validator runs
   * on save and the YAML is small). A parse failure here means the row
   * was hand-edited or the validator regressed; we log and treat the
   * project as `fast` rather than failing the whole run.
   */
  private resolveProjectGraph(
    project: { graphProfile: string; graphYaml: string | null } | null,
    cfg: MergecrewConfig,
    ctx: { runId: string; workflowRunId: string },
  ): GraphDefinition | null {
    if (project?.graphProfile === 'careful') return CAREFUL_GRAPH;
    if (project?.graphProfile === 'roster') return ROSTER_GRAPH;
    if (project?.graphProfile === 'custom') {
      if (!project.graphYaml) {
        this.deps.logger.warn(
          { ...ctx },
          'custom graph dispatch: graphYaml is empty — falling back to fast/legacy parallel dispatch',
        );
        return null;
      }
      try {
        return parseAndValidateGraphYaml(project.graphYaml, {
          availableAgentRefs: Object.keys(cfg.agents ?? {}),
        });
      } catch (err) {
        this.deps.logger.warn(
          { ...ctx, err: (err as Error).message },
          'custom graph dispatch: graphYaml failed validation at dispatch time — falling back to legacy parallel dispatch',
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Graph-driven successor dispatch (#348, #349). Called after a step
   * completes. Returns true when a follow-up step was queued — telling
   * the caller to skip `maybeAdvanceWorkflow` because the chain isn't
   * done. Returns false when no successor exists (step had no
   * graphNodeKey, or its graph node terminated at `__end__`), so the
   * caller falls through to normal workflow-advance logic.
   *
   * Reviewer routing (#349): when the completed step's graphNodeKey is
   * `reviewer`, the step's persisted `output.verdict` drives the
   * routing signal — `approve` ends the chain, `request_changes` loops
   * back to the coder. Loop-backs are capped at `REVIEW_LOOP_CAP`
   * rounds (default 3 coder passes total); the cap exhaustion path
   * emits `REVIEW_LOOP_EXHAUSTED` with the reviewer's last
   * requestedChanges and falls through to workflow advance so the
   * changeset surfaces to humans unchanged.
   */
  private async dispatchGraphNext(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    stepId: string,
  ): Promise<boolean> {
    const step = await withTenant(organizationId, (tx) =>
      tx.agentStep.findUnique({
        where: { id: stepId },
        select: { graphNodeKey: true, input: true, output: true, agentKind: true },
      }),
    );
    if (!step?.graphNodeKey) return false;

    const project = await withTenant(organizationId, (tx) =>
      tx.project.findUnique({
        where: { id: projectId },
        select: { graphProfile: true, graphYaml: true },
      }),
    );
    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    const graph = this.resolveProjectGraph(project, cfg, { runId, workflowRunId });
    if (!graph) return false;

    // Per-kind routing signals. We branch on agentKind (not
    // graphNodeKey) so a custom graph using arbitrary node names still
    // routes correctly as long as its node binds to an agent of the
    // expected kind.
    let signal: string | undefined;
    if (step.agentKind === REVIEWER_KIND) {
      const verdict = (step.output as { verdict?: string } | null)?.verdict;
      signal = verdict === 'approve' ? 'approve' : 'requestChanges';
    } else if (step.agentKind === QA_KIND) {
      // Roster QA verdict (#516, V2.af). QA emits
      // `output.verdict = 'tests_pass' | 'tests_fail'`; the ROSTER_GRAPH
      // edges route on these signals — tests_pass → deploy_dev,
      // tests_fail → pm (PM-loopback per D3 of #516). Defaults to
      // `tests_fail` if the verdict is missing so a malformed QA output
      // routes back to PM rather than silently advancing to deploy.
      const verdict = (step.output as { verdict?: string } | null)?.verdict;
      signal = verdict === 'tests_pass' ? 'tests_pass' : 'tests_fail';
    } else if (step.agentKind === PLANNER_KIND || step.agentKind === DISCOVERY_KIND) {
      // Discovery mode (#492 careful / #516 roster). The runner
      // persists `output.mode = 'discovery'` when there was no seed
      // task and the agent produced candidate directions instead of a
      // plan. Both graphs route on the `discovery` signal to terminate
      // the chain so downstream agents don't fan out against an empty
      // plan.
      const mode = (step.output as { mode?: string } | null)?.mode;
      if (mode === 'discovery') signal = 'discovery';
    }

    // Fan-in for multi-agent nodes (D1 of #516). When the completed
    // step belongs to a node that dispatches multiple parallel agents
    // (e.g. Implementation = BackendEngineer + FrontendEngineer), wait
    // for ALL members to terminate before resolving the outgoing edge.
    // Returning true here keeps the chain "in flight" without queuing
    // a successor — the next sibling's reply will re-enter here and
    // either re-wait or advance.
    const currentNode = graph.graph.nodes[step.graphNodeKey];
    if (!currentNode) return false;
    const currentAgents = getNodeAgents(currentNode);
    if (currentAgents.length > 1) {
      // Count terminal-state sibling steps on this node in this run.
      const siblingStatuses = await withTenant(organizationId, (tx) =>
        tx.agentStep.findMany({
          where: { workflowRunId, graphNodeKey: step.graphNodeKey },
          select: { status: true },
        }),
      );
      const terminal = siblingStatuses.filter((s) =>
        ['done', 'failed', 'cancelled'].includes(s.status),
      ).length;
      if (terminal < currentAgents.length) {
        // Waiting on siblings to land. Don't dispatch anything new,
        // but tell the caller the chain isn't done.
        return true;
      }
      // All terminal. Apply policy (D2).
      const failed = siblingStatuses.filter((s) =>
        ['failed', 'cancelled'].includes(s.status),
      ).length;
      const policy = currentNode.policy ?? 'strict';
      if (policy === 'strict' && failed > 0) {
        await this.deps.eventlog.emit({
          organizationId,
          projectId,
          dailyRunId: runId,
          workflowRunId,
          type: 'STAGE_FAILED',
          actor: { kind: 'system' },
          payload: {
            stage: step.graphNodeKey,
            policy: 'strict',
            failed,
            total: currentAgents.length,
          },
        });
        this.deps.logger.info(
          { runId, workflowRunId, stage: step.graphNodeKey, failed, total: currentAgents.length },
          'strict stage failed — routing to human review without advancing',
        );
        return false;
      }
      // Lenient policy, or strict with no failures: advance.
    }

    const nextKey = findNextGraphNode(graph, step.graphNodeKey, signal);
    if (nextKey === null || nextKey === GRAPH_END) return false;

    const node = graph.graph.nodes[nextKey];
    if (!node) {
      this.deps.logger.warn(
        { runId, stepId, nextKey },
        'graph dispatch: next node not in graph.nodes — falling back to workflow advance',
      );
      return false;
    }

    // Loop-back guard (#349 careful, #520 roster). When a verdict-step
    // routes back to a work-step, count completed work-step rounds in
    // this workflow run. The cap is env-set (REVIEW_LOOP_CAP, default
    // 3) — one initial work pass + up to two retries.
    //
    // Two loop shapes share the cap:
    //   * careful: Reviewer → Coder (count coder rounds)
    //   * roster:  QA → PM (count PM rounds — PM revises the spec,
    //              engineers re-implement against the new spec)
    const nextAgents = getNodeAgents(node);
    const nextAgentDef = resolveAgentByRef(cfg.agents, nextAgents[0] ?? '');
    const nextKind = nextAgentDef?.kind;
    const isCarefulLoop = step.agentKind === REVIEWER_KIND && nextKind === CODER_KIND;
    const isRosterLoop = step.agentKind === QA_KIND && nextKind === PM_KIND;
    if (isCarefulLoop || isRosterLoop) {
      const countedKind = isCarefulLoop ? CODER_KIND : PM_KIND;
      const rounds = await withTenant(organizationId, (tx) =>
        tx.agentStep.count({
          where: {
            workflowRunId,
            agentKind: countedKind,
            status: { in: ['done', 'failed', 'cancelled'] },
          },
        }),
      );
      const cap = Number(process.env.REVIEW_LOOP_CAP ?? 3);
      if (rounds >= cap) {
        const output = step.output as
          | {
              verdict?: string;
              reasoning?: string;
              requestedChanges?: string[];
              summary?: string;
              failureExcerpts?: string[];
            }
          | null;
        await this.deps.eventlog.emit({
          organizationId,
          projectId,
          dailyRunId: runId,
          workflowRunId,
          agentStepId: stepId,
          type: 'REVIEW_LOOP_EXHAUSTED',
          actor: { kind: 'system' },
          payload: isCarefulLoop
            ? {
                kind: 'careful',
                coderRounds: rounds,
                cap,
                lastReviewerReasoning: output?.reasoning ?? null,
                lastReviewerRequestedChanges: output?.requestedChanges ?? [],
              }
            : {
                kind: 'roster',
                pmRounds: rounds,
                cap,
                lastQaSummary: output?.summary ?? null,
                lastQaFailureExcerpts: output?.failureExcerpts ?? [],
              },
        });
        this.deps.logger.info(
          { runId, workflowRunId, loop: isCarefulLoop ? 'careful' : 'roster', rounds, cap },
          'loop exhausted: routing changeset to human review without further retries',
        );
        return false;
      }
    }

    // Dispatch every agent in the next node. Single-agent nodes
    // produce one job; multi-agent nodes (Implementation, Observation
    // in ROSTER_GRAPH) fan out one job per declared agent and the
    // fan-in above gates the advance until all members terminate.
    for (const ref of nextAgents) {
      await this.dispatchAgentStep(
        organizationId,
        projectId,
        runId,
        workflowRunId,
        ref,
        cfg,
        { graphNodeKey: nextKey },
      );
    }
    return true;
  }

  /**
   * Careful-profile entry: pick the graph's entry node and queue the
   * first step. Records `graphNodeKey` on the agent_step so
   * `onStepReply` can find the next node when the step completes.
   * Fails the workflow cleanly when the entry node is ambiguous or
   * its agent can't be resolved — neither should happen on a project
   * created through the normal settings UI (the validator catches both
   * at save time), but a hand-edited DB row could land here.
   *
   * Multi-agent entry nodes (#516, V2.af) fan out a job per declared
   * `agents` member — currently ROSTER_GRAPH's entry is single-agent
   * (`discovery`) but the loop here keeps the dispatcher correct if a
   * future custom graph declares a multi-agent entry.
   */
  private async dispatchGraphEntry(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    cfg: MergecrewConfig,
    graph: GraphDefinition,
  ) {
    const entry = findGraphEntryNode(graph);
    if (!entry) {
      this.deps.logger.warn(
        { runId, workflowRunId },
        'careful dispatch: graph has no unique entry node — failing workflow',
      );
      await this.completeWorkflow(organizationId, projectId, runId, workflowRunId, 'careful-no-entry');
      return;
    }
    const node = graph.graph.nodes[entry]!;
    for (const ref of getNodeAgents(node)) {
      await this.dispatchAgentStep(
        organizationId,
        projectId,
        runId,
        workflowRunId,
        ref,
        cfg,
        { graphNodeKey: entry },
      );
    }
  }

  private async dispatchAgentStep(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    agentRef: string,
    cfg: MergecrewConfig,
    opts?: { graphNodeKey?: string },
  ) {
    // `resolveAgentByRef` covers careful-profile stock fallback so a
    // project on `graphProfile=careful` doesn't have to copy three
    // agent stubs into its `mergecrew.yaml`. For `fast` it still falls
    // back to lifecycle agents only — operators see the same warning
    // they did before for V1 single-agent flows that reference an
    // undefined agentRef.
    const agentDef = resolveAgentByRef(cfg.agents, agentRef);
    if (!agentDef) {
      this.deps.logger.warn({ agentRef }, 'unknown agent ref');
      return;
    }

    // V1.3 cancellation: if the run was cancelled between scheduling and
    // dispatch, don't queue another step. The runner double-checks this
    // too, so a step that races the cancel still fails closed.
    const run = await withTenant(organizationId, (tx) =>
      tx.dailyRun.findUnique({ where: { id: runId }, select: { status: true } }),
    );
    if (run?.status === 'cancelled') {
      this.deps.logger.info(
        { runId, agentRef },
        'dispatch: skipping step — run is cancelled',
      );
      return;
    }
    if (run?.status === 'paused_gate' || run?.status === 'paused_rate_limit') {
      // A different step in the same run is paused on a gate or rate-limit.
      // Don't pile new steps onto an already-paused run; the resume path
      // re-dispatches what's needed.
      this.deps.logger.info(
        { runId, agentRef, status: run.status },
        'dispatch: skipping step — run is paused',
      );
      return;
    }

    // Per-org concurrency cap (V1.3, #9). If the org has more in-flight
    // (pending or running) steps than its cap, defer this dispatch by
    // re-queueing it with a delay. The same job re-enters here after the
    // delay and re-checks. We don't create the agent_steps row yet so the
    // count it's compared against stays accurate while the deferral chain
    // resolves.
    const org = await withTenant(organizationId, (tx) =>
      tx.organization.findUnique({
        where: { id: organizationId },
        select: { orgConcurrencyCap: true },
      }),
    );
    const cap = org?.orgConcurrencyCap ?? 0;
    if (cap > 0) {
      const inflight = await withTenant(organizationId, (tx) =>
        tx.agentStep.count({
          where: { organizationId, status: { in: ['pending', 'running'] } },
        }),
      );
      if (inflight >= cap) {
        const delayMs = Number(process.env.ORG_CAP_DEFERRAL_MS ?? 5_000);
        this.deps.logger.info(
          { organizationId, projectId, agentRef, inflight, cap, delayMs },
          'org-cap: deferring step dispatch — org at concurrency cap',
        );
        await this.orgCapWaitQueue.add(
          'agent-step',
          { organizationId, projectId, runId, workflowRunId, agentRef },
          { delay: delayMs, removeOnComplete: 1000, removeOnFail: 1000 },
        );
        return;
      }
    }

    const step = await withTenant(organizationId, (tx) =>
      tx.agentStep.create({
        data: {
          organizationId,
          workflowRunId,
          agentKind: agentDef.kind,
          agentInstanceId: stableUuid(`${projectId}:${agentRef}`),
          status: 'pending',
          input: { agentRef, workflowRunId },
          ...(opts?.graphNodeKey ? { graphNodeKey: opts.graphNodeKey } : {}),
        },
      }),
    );
    await this.runner.add(
      'step',
      {
        organizationId,
        projectId,
        runId,
        workflowRunId,
        stepId: step.id,
        agentRef,
      },
      { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
    );
  }

  /**
   * Waker for org-cap deferred dispatches (V1.3, #9). Re-enters the
   * dispatch path with the same params; if the org still exceeds its cap
   * the job is re-deferred by `dispatchAgentStep`.
   */
  async handleOrgCapWait(data: {
    organizationId: string;
    projectId: string;
    runId: string;
    workflowRunId: string;
    agentRef: string;
  }): Promise<void> {
    const lc = await withTenant(data.organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId: data.projectId }, orderBy: { version: 'desc' } }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    await this.dispatchAgentStep(
      data.organizationId,
      data.projectId,
      data.runId,
      data.workflowRunId,
      data.agentRef,
      cfg,
    );
  }

  // ─── 3. Step reply (sent by runner) ─────────────────────────────────────

  async onStepReply(data: {
    organizationId: string;
    projectId: string;
    runId: string;
    workflowRunId: string;
    stepId: string;
    outcome:
      | { kind: 'completed'; output?: unknown; toolCallsMade?: number; totalTokens?: number }
      | { kind: 'failed'; reason: string }
      | { kind: 'rate_limited'; retryAfterMs: number; providerKind?: string }
      | { kind: 'gated_reject'; reason: string }
      | { kind: 'gate_pending'; approvalId: string; reason?: string }
      | { kind: 'cancelled' }
      | { kind: 'budget_exhausted'; reason?: string };
  }): Promise<void> {
    const { organizationId, projectId, runId, workflowRunId, stepId, outcome } = data;
    if (outcome.kind === 'gate_pending') {
      // Runner persisted an ApprovalRequest + RunPause(kind='gate') already.
      // We just transition the run + step into paused_gate and stop here —
      // we explicitly do NOT advance the workflow. resumeGate re-dispatches
      // this step once a human approves.
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'paused_gate' },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.dailyRun.update({ where: { id: runId }, data: { status: 'paused_gate' } }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'RUN_PAUSED_GATE',
        actor: { kind: 'system' },
        payload: { approvalId: outcome.approvalId, reason: outcome.reason },
      });
      return;
    }
    if (outcome.kind === 'rate_limited') {
      await withTenant(organizationId, (tx) =>
        tx.runPause.create({
          data: {
            organizationId,
            dailyRunId: runId,
            stepId,
            kind: 'rate_limit',
            wakeAt: new Date(Date.now() + outcome.retryAfterMs + Math.floor(Math.random() * 30_000)),
          },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.dailyRun.update({ where: { id: runId }, data: { status: 'paused_rate_limit' } }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'RUN_PAUSED_RATE_LIMIT',
        actor: { kind: 'system' },
        payload: outcome,
      });
      // Schedule a wake-up.
      await this.wake.add(
        'wake',
        { runId, stepId, organizationId, projectId, workflowRunId },
        { delay: outcome.retryAfterMs + 1000, removeOnComplete: 1000 },
      );
      return;
    }
    if (outcome.kind === 'completed') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'done', finishedAt: new Date(), output: (outcome.output ?? null) as any },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_COMPLETED',
        actor: { kind: 'system' },
        payload: { totalTokens: outcome.totalTokens },
      });
      // Graph-driven dispatch (#348): if the completed step belongs to
      // a graph chain, queue the next node before deciding whether the
      // workflow is done. `dispatchGraphNext` returns true when it
      // queued another step — in that case we skip `maybeAdvanceWorkflow`
      // because the workflow still has work in flight.
      const dispatched = await this.dispatchGraphNext(
        organizationId,
        projectId,
        runId,
        workflowRunId,
        stepId,
      );
      if (!dispatched) {
        await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      }
      return;
    }
    if (outcome.kind === 'gated_reject') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { status: 'failed', failureReason: outcome.reason, finishedAt: new Date() },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: { reason: outcome.reason },
      });
      await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      return;
    }
    if (outcome.kind === 'failed' || outcome.kind === 'budget_exhausted' || outcome.kind === 'cancelled') {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: {
            status: outcome.kind === 'cancelled' ? 'cancelled' : 'failed',
            failureReason: (outcome as any).reason ?? outcome.kind,
            finishedAt: new Date(),
          },
        }),
      );
      await this.deps.eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: { reason: (outcome as any).reason ?? outcome.kind },
      });
      await this.maybeAdvanceWorkflow(organizationId, projectId, runId, workflowRunId);
      return;
    }
  }

  // ─── 4. Workflow advance ────────────────────────────────────────────────

  private async maybeAdvanceWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
  ) {
    // A workflow advances only when every step has reached a terminal
    // state (done/failed/cancelled). Steps paused on a gate or rate-limit
    // are still in flight — counting them as "remaining" keeps the
    // workflow from advancing past a step a human still needs to approve.
    const remaining = await withTenant(organizationId, (tx) =>
      tx.agentStep.count({
        where: {
          workflowRunId,
          status: { notIn: ['done', 'failed', 'cancelled'] },
        },
      }),
    );
    if (remaining > 0) return;

    const wfr = await withTenant(organizationId, (tx) =>
      tx.workflowRun.findUnique({ where: { id: workflowRunId } }),
    );
    if (!wfr) return;

    await withTenant(organizationId, (tx) =>
      tx.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: 'done', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      type: 'WORKFLOW_COMPLETED',
      actor: { kind: 'system' },
      payload: { workflowId: wfr.workflowId },
    });

    const lc = await withTenant(organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
    );
    const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
    const wf = cfg.lifecycle.workflows.find((w) => w.id === wfr.workflowId);
    const next = wf?.out ?? [];
    if (next.length === 0) {
      await this.completeRun(organizationId, projectId, runId);
      return;
    }
    for (const n of next) {
      await this.startWorkflow(organizationId, projectId, runId, n);
    }
  }

  private async completeWorkflow(
    organizationId: string,
    projectId: string,
    runId: string,
    workflowRunId: string,
    reason: string,
  ) {
    await withTenant(organizationId, (tx) =>
      tx.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: 'failed', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      type: 'WORKFLOW_COMPLETED',
      actor: { kind: 'system' },
      payload: { reason },
    });
  }

  private async completeRun(organizationId: string, projectId: string, runId: string) {
    await withTenant(organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: runId },
        data: { status: 'done', finishedAt: new Date() },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      type: 'RUN_COMPLETED',
      actor: { kind: 'system' },
      payload: {},
    });
    // Run-terminal workspace cleanup. The runner's `runner.workspace-cleanup`
    // worker rms /<workspaceRoot>/<runId>/ best-effort. Cancel/fail paths
    // enqueue from their own call sites (api.run.cancel, etc).
    await this.workspaceCleanupQueue
      .add('cleanup', { runId }, { removeOnComplete: 1000, removeOnFail: 1000 })
      .catch((err) =>
        this.deps.logger.warn(
          { runId, err: err?.message ?? err },
          'workspace-cleanup: enqueue failed; workspace will leak until next sweep',
        ),
      );
    void telemetry.emit(organizationId, 'run.completed', { status: 'done' });
  }

  // ─── 5. Resumes ─────────────────────────────────────────────────────────

  async resumeRateLimit(data: {
    organizationId: string;
    projectId: string;
    runId: string;
    stepId: string;
    workflowRunId: string;
  }): Promise<void> {
    await withTenant(data.organizationId, (tx) =>
      tx.runPause.updateMany({
        where: { dailyRunId: data.runId, stepId: data.stepId, resumedAt: null, kind: 'rate_limit' },
        data: { resumedAt: new Date() },
      }),
    );
    await withTenant(data.organizationId, (tx) =>
      tx.dailyRun.update({
        where: { id: data.runId },
        data: { status: 'running' },
      }),
    );
    await this.deps.eventlog.emit({
      organizationId: data.organizationId,
      projectId: data.projectId,
      dailyRunId: data.runId,
      agentStepId: data.stepId,
      type: 'RUN_RESUMED',
      actor: { kind: 'system' },
      payload: {},
    });
    // Re-dispatch the step with same input (idempotent for the runner).
    const step = await withTenant(data.organizationId, (tx) =>
      tx.agentStep.findUnique({ where: { id: data.stepId } }),
    );
    if (!step) return;
    const input = step.input as any;
    await this.runner.add(
      'step',
      {
        organizationId: data.organizationId,
        projectId: data.projectId,
        runId: data.runId,
        workflowRunId: data.workflowRunId,
        stepId: data.stepId,
        agentRef: input?.agentRef,
      },
      { removeOnComplete: 1000 },
    );
  }

  async resumeGate(data: { approvalId: string; resolution: 'approve' | 'reject' | 'takeover' }): Promise<void> {
    // Look up the approval (system bypass — org is unknown until we read it)
    // then scope every subsequent write to that org via withTenant.
    const ar = await (await import('@mergecrew/db')).withSystem((tx) =>
      tx.approvalRequest.findUnique({ where: { id: data.approvalId } }),
    );
    if (!ar) return;

    // The RunPause row records exactly which run + step were waiting on
    // this approval. We scope by that, not by org-wide `status='paused_gate'`
    // — sibling runs paused on different gates must stay paused.
    const pause = await withTenant(ar.organizationId, (tx) =>
      tx.runPause.findFirst({
        where: { approvalRequestId: ar.id, kind: 'gate', resumedAt: null },
      }),
    );
    if (!pause) {
      this.deps.logger.info(
        { approvalId: ar.id, resolution: data.resolution },
        'resumeGate: no open RunPause for this approval — already resumed or never paused',
      );
      return;
    }

    await withTenant(ar.organizationId, (tx) =>
      tx.runPause.update({ where: { id: pause.id }, data: { resumedAt: new Date() } }),
    );

    // Only flip daily_run back to 'running' when no other gate or
    // rate-limit pause is still open for this run — otherwise we'd
    // un-pause a run that's still waiting on a sibling gate or wake.
    const stillPaused = await withTenant(ar.organizationId, (tx) =>
      tx.runPause.count({
        where: { dailyRunId: pause.dailyRunId, resumedAt: null },
      }),
    );

    if (data.resolution !== 'approve') {
      if (pause.stepId) {
        await withTenant(ar.organizationId, (tx) =>
          tx.agentStep.update({
            where: { id: pause.stepId! },
            data: {
              status: 'failed',
              failureReason: `gate_${data.resolution}`,
              finishedAt: new Date(),
            },
          }),
        );
      }
      if (stillPaused === 0) {
        await withTenant(ar.organizationId, (tx) =>
          tx.dailyRun.update({
            where: { id: pause.dailyRunId },
            data: { status: 'running' },
          }),
        );
      }
      await this.deps.eventlog.emit({
        organizationId: ar.organizationId,
        projectId: ar.projectId,
        dailyRunId: pause.dailyRunId,
        agentStepId: pause.stepId ?? null,
        type: 'RUN_RESUMED',
        actor: { kind: 'system' },
        payload: { resolution: data.resolution },
      });
      if (pause.stepId) {
        await this.maybeAdvanceWorkflow(ar.organizationId, ar.projectId, pause.dailyRunId, ar.workflowRunId);
      }
      return;
    }

    // Approve: re-dispatch the same step. The runner is idempotent on
    // agent_steps.id so a re-run from the top is safe; the step's `input`
    // carries the original agentRef.
    if (stillPaused === 0) {
      await withTenant(ar.organizationId, (tx) =>
        tx.dailyRun.update({
          where: { id: pause.dailyRunId },
          data: { status: 'running' },
        }),
      );
    }
    await this.deps.eventlog.emit({
      organizationId: ar.organizationId,
      projectId: ar.projectId,
      dailyRunId: pause.dailyRunId,
      agentStepId: pause.stepId ?? null,
      type: 'RUN_RESUMED',
      actor: { kind: 'system' },
      payload: { resolution: 'approve' },
    });

    if (!pause.stepId) return;
    const step = await withTenant(ar.organizationId, (tx) =>
      tx.agentStep.findUnique({ where: { id: pause.stepId! } }),
    );
    if (!step) return;
    await withTenant(ar.organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: step.id },
        data: { status: 'pending' },
      }),
    );
    const input = step.input as any;
    await this.runner.add(
      'step',
      {
        organizationId: ar.organizationId,
        projectId: ar.projectId,
        runId: pause.dailyRunId,
        workflowRunId: ar.workflowRunId,
        stepId: step.id,
        agentRef: input?.agentRef,
      },
      { removeOnComplete: 1000 },
    );
  }

  // ─── 6. Dispatch (manual operations) ────────────────────────────────────

  async handleDispatch(name: string, data: any): Promise<void> {
    if (name === 'promote') {
      await this.deps.eventlog.emit({
        organizationId: data.organizationId,
        projectId: data.projectId ?? '',
        changesetId: data.changesetId,
        type: 'CHANGESET_PROMOTED',
        actor: { kind: 'user', id: data.userId },
        payload: { changesetId: data.changesetId },
      });
      // The dev->prod adapter call lives in the runner via a synthetic step.
    }
    if (name === 'rollback') {
      await this.deps.eventlog.emit({
        organizationId: data.organizationId,
        projectId: data.projectId ?? '',
        changesetId: data.changesetId,
        type: 'CHANGESET_ROLLED_BACK',
        actor: { kind: 'user', id: data.userId },
        payload: { changesetId: data.changesetId },
      });
    }
  }

  async handleWebhook(name: string, data: any): Promise<void> {
    this.deps.logger.info({ name }, 'webhook received');
    if (name === 'slack') {
      await handleSlackInteractivity(data?.event, {
        logger: this.deps.logger,
        eventlog: this.deps.eventlog,
        dispatchQueue: this.dispatchQueue,
      });
      return;
    }
    if (name === 'sentry') {
      await handleSentryWebhook({ payload: data?.event, logger: this.deps.logger });
      return;
    }
    // Other webhooks feed the Discovery agent's input on the next run.
  }

  // ─── Digest ─────────────────────────────────────────────────────────────

  /**
   * End-of-day digest dispatcher. The worker-cron `digestTick` enqueues
   * one of these per project at end-of-working-hours; we fan-out into the
   * configured channels. Email (#82) and per-org Slack workspace install
   * (#93) are still pending — for now Slack uses a global bot token.
   */
  async handleDigestDispatch(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    const { organizationId, projectId, eod } = data;
    const channels: string[] = [];

    if (process.env.SLACK_BOT_TOKEN) {
      await this.digestSlack.add(
        'digest.slack',
        { organizationId, projectId, eod },
        { removeOnComplete: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      channels.push('slack');
    } else {
      this.deps.logger.info({ projectId }, 'digest.dispatch: SLACK_BOT_TOKEN not set; skipping slack');
    }

    // Email opt-in: SMTP_URL or RESEND_API_KEY configured in any env, or
    // DIGEST_EMAIL_ENABLED=1 (the latter routes to the dev-mode console-
    // logger inside EmailClient).
    if (emailEnabledFromEnv() || process.env.DIGEST_EMAIL_ENABLED === '1') {
      await this.digestEmail.add(
        'digest.email',
        { organizationId, projectId, eod },
        { removeOnComplete: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      channels.push('email');
    } else {
      this.deps.logger.info(
        { projectId },
        'digest.dispatch: neither SMTP_URL nor RESEND_API_KEY set; skipping email',
      );
    }

    await this.deps.eventlog.emit({
      organizationId,
      projectId,
      type: 'DIGEST_DISPATCHED',
      actor: { kind: 'system' },
      payload: { eod, channels },
    });
  }

  /**
   * Slack-channel fan-out. Loads project members + active changesets,
   * builds a block-kit digest, then DMs each member by email lookup.
   * Per-recipient errors are logged but don't fail the job — partial
   * delivery is better than retrying the whole thing.
   */
  async handleSlackDigest(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    await dispatchSlackDigest({
      organizationId: data.organizationId,
      projectId: data.projectId,
      eod: new Date(data.eod),
      logger: this.deps.logger,
    });
  }

  /**
   * Email-channel fan-out. Loads project + active changesets, renders the
   * HTML digest template, and sends one email to all org members with a
   * resolvable email. Bounces/rejects are nodemailer's problem; the worker
   * retries on transport failure.
   */
  async handleEmailDigest(data: { organizationId: string; projectId: string; eod: string }): Promise<void> {
    await dispatchEmailDigest({
      organizationId: data.organizationId,
      projectId: data.projectId,
      eod: new Date(data.eod),
      logger: this.deps.logger,
    });
  }
}

function stableUuid(s: string): string {
  // Tiny deterministic UUID-like id for in-memory references.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return `00000000-0000-4000-a000-${(Math.abs(h) >>> 0).toString(16).padStart(12, '0')}`;
}

export { newRunIdForDate, shortId };
