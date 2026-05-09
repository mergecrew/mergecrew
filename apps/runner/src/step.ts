import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import {
  type AgentDefinition,
  type MergecrewConfig,
  type ModelCapability,
  type StepOutcome,
  type TestSummary,
} from '@mergecrew/domain';
import { parseTestOutput, mergeIntoSummary } from './test-summary.js';
import { Eventlog } from '@mergecrew/eventlog';
import {
  CapabilityRouter,
  CircuitBreaker,
  ProviderRegistry,
  estimateUsd,
  priceFor,
  type LlmProfile,
} from '@mergecrew/llm';
import { stockSkills, buildHttpSkill, SkillExecutor, type SkillExecutionContext } from '@mergecrew/skills';
import { GitHubProvider, type VcsProvider } from '@mergecrew/adapters-vcs';
import {
  GitHubActionsProvider,
  VercelProvider,
  type DeployProvider,
} from '@mergecrew/adapters-deploy';
import { LinearProvider, GitHubIssuesProvider, type TrackerProvider } from '@mergecrew/adapters-tracker';

const TRACKER_TOKEN_SECRET = 'TRACKER_TOKEN';
import { CompositeCommsProvider } from '@mergecrew/adapters-comms';
import { runAgentStep, BudgetTracker, PolicyEngine } from '@mergecrew/agent-runtime';

interface StepArgs {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
  eventlog: Eventlog;
  logger: Logger;
}

export async function runStep(args: StepArgs): Promise<StepOutcome> {
  const { organizationId, projectId, runId, workflowRunId, stepId, agentRef, eventlog, logger } = args;
  await withTenant(organizationId, (tx) =>
    tx.agentStep.update({
      where: { id: stepId },
      data: { status: 'running', startedAt: new Date(), attempt: { increment: 1 } },
    }),
  );
  await eventlog.emit({
    organizationId,
    projectId,
    dailyRunId: runId,
    workflowRunId,
    agentStepId: stepId,
    type: 'AGENT_STEP_STARTED',
    actor: { kind: 'system' },
    payload: { agentRef },
  });

  const lc = await withTenant(organizationId, (tx) =>
    tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
  );
  const cfg = (lc?.parsed ?? {}) as MergecrewConfig;
  const agentDef = (cfg.agents?.[agentRef] ?? {
    kind: agentRef,
    skills: [],
    do_not_touch: [],
    fallback: [],
    maxStepsPerRun: 12,
    maxToolCallsPerStep: 8,
  }) as AgentDefinition;

  const llmProviders = await withTenant(organizationId, (tx) =>
    tx.llmProvider.findMany({ where: { organizationId } }),
  );
  const profiles = await withTenant(organizationId, (tx) =>
    tx.llmProfile.findMany({ where: { organizationId } }),
  );

  const registry = new ProviderRegistry(
    llmProviders.map((p) => ({
      id: p.id,
      kind: p.kind as any,
      apiKey: p.credentialCiphertext ? decryptDevOnly(p.credentialCiphertext) : undefined,
      endpoint: p.endpoint ?? undefined,
      awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      models: ((p.capabilityOverrides as any)?.models ?? []) as string[],
    })),
  );
  const router = new CapabilityRouter(registry, new CircuitBreaker());

  const profile: LlmProfile = profiles[0]
    ? {
        id: profiles[0].id,
        name: profiles[0].name,
        preferenceOrder: profiles[0].preferenceOrder as string[],
        capabilityRouting: profiles[0].capabilityRouting as Record<string, ModelCapability>,
      }
    : { id: 'default', name: 'default', preferenceOrder: [], capabilityRouting: {} };

  // Workspace per-step. In dev defaults to a tmp dir; in prod set
  // RUNNER_WORKSPACE_ROOT to an ephemeral, writable location (e.g. the
  // ECS task's /var/mergecrew/work mount).
  const workspaceRoot =
    process.env.RUNNER_WORKSPACE_ROOT ?? path.join(process.env.TMPDIR ?? '/tmp', 'mergecrew-work');
  const workspacePath = path.join(workspaceRoot, runId, stepId);
  await fs.mkdir(workspacePath, { recursive: true });

  // VCS adapter from env (only used by skills that touch the repo).
  let vcs: VcsProvider | undefined;
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
    vcs = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
  }

  // Deploy adapter selection: pick the dev target, decide adapter from its config.
  const dt = await withTenant(organizationId, (tx) =>
    tx.deployTarget.findFirst({ where: { projectId, kind: 'dev' } }),
  );
  let deploy: DeployProvider | undefined;
  if (dt?.adapterId === 'github-actions' && process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) {
    deploy = new GitHubActionsProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
  } else if (dt?.adapterId === 'vercel' && process.env.VERCEL_TOKEN) {
    deploy = new VercelProvider({ token: process.env.VERCEL_TOKEN });
  }

  // Tracker adapter — per-project. Reads tracker_targets + the encrypted
  // TRACKER_TOKEN secret. If either is missing we leave it undefined so skills
  // that need a tracker can fail with a clear message.
  let tracker: TrackerProvider | undefined;
  const trackerTarget = await withTenant(organizationId, (tx) =>
    tx.trackerTarget.findUnique({ where: { projectId } }),
  );
  if (trackerTarget) {
    const tokenRow = await withTenant(organizationId, (tx) =>
      tx.projectSecret.findFirst({
        where: { projectId, name: TRACKER_TOKEN_SECRET },
      }),
    );
    if (tokenRow) {
      const token = decryptDevOnly(tokenRow.ciphertext);
      if (trackerTarget.adapterId === 'github-issues') {
        const repoFullName = (trackerTarget.config as any)?.repoFullName ?? '';
        if (repoFullName) tracker = new GitHubIssuesProvider({ installationToken: token, repoFullName });
      } else if (trackerTarget.adapterId === 'linear') {
        tracker = new LinearProvider({ apiKey: token });
      }
    }
  }

  const comms = new CompositeCommsProvider({
    email: { from: process.env.MERGECREW_EMAIL_FROM ?? 'noreply@mergecrew.dev', smtpUrl: process.env.SMTP_URL },
  });

  const skills = new SkillExecutor();
  skills.registerAll(stockSkills);
  for (const [name, def] of Object.entries(cfg.skills ?? {})) {
    skills.register(buildHttpSkill(name, def));
  }

  const policy = new PolicyEngine({
    agentDoNotTouch: agentDef.do_not_touch,
    projectSensitivePatterns: cfg.lifecycle?.human_gates?.sensitive_path_patterns ?? [],
    projectHardBlocked: ['**/.env*'],
  });

  const budget = new BudgetTracker(agentDef.budget);
  const abortController = new AbortController();

  const buildSkillContext: (extra: { skillName: string; toolUseId: string }) => SkillExecutionContext = (extra) => ({
    organizationId,
    projectId,
    runId,
    agentStepId: stepId,
    workspacePath,
    abortSignal: abortController.signal,
    logger: {
      info: (m, meta) => logger.info({ ...meta, skillName: extra.skillName }, m),
      warn: (m, meta) => logger.warn({ ...meta, skillName: extra.skillName }, m),
      error: (m, meta) => logger.error({ ...meta, skillName: extra.skillName }, m),
    },
    emit: async () => {
      /* runner doesn't push extra events from skills in V1 */
    },
    adapters: { vcs, deploy, tracker, comms },
    config: {
      // Per-skill / per-step config bag the runner injects.
      adapterConfig: dt?.config ?? {},
    },
  });

  // Hard daily budget gate. If today's org-wide spend already meets or
  // exceeds the configured cap, refuse the step before any LLM call. The
  // budget is intentionally checked at step entry (not per-iteration) so
  // a single step can't be more than one model turn over budget.
  const budgetGate = await checkDailyBudget(organizationId);
  if (budgetGate.exceeded) {
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'AGENT_STEP_FAILED',
      actor: { kind: 'system' },
      payload: {
        reason: 'org_daily_budget_exhausted',
        spentUsd: budgetGate.spent,
        budgetUsd: budgetGate.budget,
      },
    });
    return {
      kind: 'budget_exhausted',
      reason: `org daily budget exhausted: spent $${budgetGate.spent.toFixed(2)} of $${budgetGate.budget?.toFixed(2)}`,
    };
  }

  const initialInput = await synthesizeAgentInput(organizationId, projectId, runId, agentRef, cfg);

  const outcome = await runAgentStep({
    organizationId,
    projectId,
    runId,
    workflowRunId,
    agentStepId: stepId,
    agent: agentDef,
    skills,
    router,
    llmProfile: profile,
    policy,
    eventlog,
    budget,
    buildSkillContext,
    abortSignal: abortController.signal,
    capabilityFromAgent: () => ({ tools: agentDef.skills.length > 0, longContext: 200_000 }),
    initialInput,
    onGateRequired: async (decision, args2) => {
      // Persist an approval, mark the daily run paused-gate, return 'rejected' to halt.
      const ar = await withTenant(organizationId, (tx) =>
        tx.approvalRequest.create({
          data: {
            organizationId,
            projectId,
            workflowRunId,
            reason: decision.reason ?? 'sensitive_path',
            details: { skill: args2.skillName, input: args2.input, detail: decision.detail } as any,
            requiredRole: 'operator',
          },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.runPause.create({
          data: {
            organizationId,
            dailyRunId: runId,
            stepId,
            kind: 'gate',
            approvalRequestId: ar.id,
          },
        }),
      );
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'GATE_REACHED',
        actor: { kind: 'system' },
        payload: { reason: decision.reason, approvalRequestId: ar.id },
      });
      // V1: synchronous wait would block the runner; we instead reject this iteration and
      // let the user resolve the gate; the orchestrator re-dispatches on approve.
      return 'rejected';
    },
    recordModelTurn: async (turn) => {
      const usd = turn.usdEstimate;
      const seq = await nextSequence('model', stepId);
      await withTenant(organizationId, (tx) =>
        tx.modelTurn.create({
          data: {
            organizationId,
            agentStepId: stepId,
            sequence: seq,
            providerId: turn.providerId,
            modelId: turn.modelId,
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            cacheReadTokens: turn.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: turn.usage.cacheWriteTokens ?? 0,
            thinkingTokens: turn.usage.thinkingTokens ?? null,
            latencyMs: turn.latencyMs,
            usdEstimate: usd,
          },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.llmInvocation.create({
          data: {
            organizationId,
            projectId,
            runId,
            agentStepId: stepId,
            providerId: turn.providerId,
            modelId: turn.modelId,
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            cacheReadTokens: turn.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: turn.usage.cacheWriteTokens ?? 0,
            thinkingTokens: turn.usage.thinkingTokens ?? null,
            latencyMs: turn.latencyMs,
            usdEstimate: usd,
          },
        }),
      );
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: {
            totalInputTokens: { increment: turn.usage.inputTokens },
            totalOutputTokens: { increment: turn.usage.outputTokens },
            totalUsdEstimate: { increment: usd },
          },
        }),
      );
    },
    recordToolCall: async (call) => {
      await withTenant(organizationId, (tx) =>
        tx.toolCall.create({
          data: {
            organizationId,
            agentStepId: stepId,
            sequence: call.sequence,
            skillName: call.skillName,
            input: call.input as any,
            output: (call.output ?? null) as any,
            isError: call.isError,
            startedAt: call.startedAt,
            finishedAt: call.finishedAt,
            sideEffectClass: call.sideEffectClass,
          },
        }),
      );
      // Materialize a Changeset row when an agent successfully commits.
      // Subsequent commits on the same branch update the existing row.
      if (call.skillName === 'repo.git.commit' && !call.isError) {
        await ensureChangesetForCommit({
          organizationId,
          projectId,
          runId,
          workflowRunId,
          input: call.input as { message?: string; type?: string; scope?: string } | null,
          output: call.output as { sha?: string; branch?: string; message?: string } | null,
          eventlog,
        });
      }
      // Capture build/test output into the active Changeset's testSummary.
      if (BUILD_TEST_SKILLS.has(call.skillName)) {
        await recordBuildResult({
          organizationId,
          projectId,
          runId,
          workflowRunId,
          skillName: call.skillName,
          output: call.output as { stdout?: string; stderr?: string; exitCode?: number } | null,
          isError: call.isError,
          eventlog,
        });
      }
    },
  });

  // After the loop: open PRs for any active changesets that don't have one
  // yet. Best-effort — failures log + leave the changeset in its current
  // status so a follow-up step or human can retry.
  if (vcs && outcome.kind !== 'failed' && outcome.kind !== 'budget_exhausted') {
    await openPendingChangesetPrs({
      organizationId,
      projectId,
      runId,
      workflowRunId,
      vcs,
      workspacePath,
      eventlog,
      logger,
    });
  }

  // After PRs are open: trigger the dev-target deploy for each changeset
  // that doesn't already have one. Same best-effort posture as PR opening.
  if (deploy && dt && outcome.kind !== 'failed' && outcome.kind !== 'budget_exhausted') {
    await triggerPendingDevDeploys({
      organizationId,
      projectId,
      runId,
      workflowRunId,
      deploy,
      deployTarget: dt,
      eventlog,
      logger,
    });
  }

  // Cleanup workspace.
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});

  // We export a price helper so the runtime can attach $ to model turns.
  void priceFor;
  void estimateUsd;

  return outcome;
}

/**
 * Decrypt-on-read helper. In production the runner asks the API for a short-
 * lived plaintext per call. For V1 monorepo simplicity we re-implement the
 * envelope decryption inline using the same KMS_MASTER_KEY.
 */
function decryptDevOnly(blob: Buffer): string {
  const crypto = require('node:crypto');
  const v = process.env.KMS_MASTER_KEY ?? '';
  const buf = Buffer.from(v.replace(/^base64:/, ''), 'base64');
  if (buf.length !== 32) return '';
  if (blob[0] !== 1) return '';
  let pos = 1;
  const wrapIv = blob.subarray(pos, pos + 12); pos += 12;
  const wrapTag = blob.subarray(pos, pos + 16); pos += 16;
  const wrapped = blob.subarray(pos, pos + 32); pos += 32;
  const iv = blob.subarray(pos, pos + 12); pos += 12;
  const tag = blob.subarray(pos, pos + 16); pos += 16;
  const ct = blob.subarray(pos);
  const wrap = crypto.createDecipheriv('aes-256-gcm', buf, wrapIv);
  wrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([wrap.update(wrapped), wrap.final()]);
  const dec = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return pt.toString('utf8');
}

/**
 * Find or create the Changeset row for this run + branch on a successful
 * `repo.git.commit`. Subsequent commits on the same branch update
 * `updatedAt`; a Changeset is keyed on `(dailyRunId, branch)` because a
 * single run may produce multiple feature branches.
 *
 * Title is the commit subject; whyParagraph is the body of a multi-line
 * commit message (lines after a blank line). Status starts at `proposed`;
 * downstream tickets advance through `building → testing → pr_open →
 * dev_deployed`.
 */
async function ensureChangesetForCommit(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  input: { message?: string; type?: string; scope?: string } | null;
  output: { sha?: string; branch?: string; message?: string } | null;
  eventlog: Eventlog;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, input, output, eventlog } = opts;
  const branch = output?.branch;
  if (!branch) return; // detached HEAD or branch lookup failed; skip

  const fullMessage = output?.message ?? input?.message ?? '';
  const { title, whyParagraph } = splitCommitMessage(fullMessage);

  const existing = await withTenant(organizationId, (tx) =>
    tx.changeset.findFirst({ where: { dailyRunId: runId, branch } }),
  );

  if (existing) {
    await withTenant(organizationId, (tx) =>
      tx.changeset.update({
        where: { id: existing.id },
        data: { updatedAt: new Date() },
      }),
    );
    return;
  }

  const id = `cs-${runId.slice(0, 8)}-${branch.slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const created = await withTenant(organizationId, (tx) =>
    tx.changeset.create({
      data: {
        id,
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        branch,
        title: title || branch,
        whyParagraph: whyParagraph || null,
        status: 'proposed',
      },
    }),
  );
  await eventlog.emit({
    organizationId,
    projectId,
    dailyRunId: runId,
    workflowRunId,
    changesetId: created.id,
    type: 'CHANGESET_OPENED',
    actor: { kind: 'system' },
    payload: { branch, sha: output?.sha, title: created.title },
  });
}

/**
 * After an agent step completes, push every still-open changeset's branch
 * and open a PR for it. Idempotent — changesets that already have
 * `prNumber` are skipped. Failures are logged and don't abort the rest of
 * the run.
 */
async function openPendingChangesetPrs(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  vcs: VcsProvider;
  workspacePath: string;
  eventlog: Eventlog;
  logger: Logger;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, vcs, workspacePath, eventlog, logger } = opts;

  const repo = await withTenant(organizationId, (tx) =>
    tx.connectedRepo.findUnique({ where: { projectId } }),
  );
  if (!repo) return;

  const changesets = await withTenant(organizationId, (tx) =>
    tx.changeset.findMany({
      where: {
        dailyRunId: runId,
        prNumber: null,
        status: { in: ['proposed', 'building', 'testing', 'tests_failed'] },
      },
    }),
  );
  if (changesets.length === 0) return;

  const repoRef = {
    installationId: repo.installationId,
    repoId: repo.repoId ?? undefined,
    repoFullName: repo.repoFullName,
    defaultBranch: repo.defaultBranch,
  };

  for (const cs of changesets) {
    try {
      await vcs.push(workspacePath, cs.branch);
      const body = buildPrBody(cs);
      const pr = await vcs.openPullRequest(repoRef, {
        head: cs.branch,
        base: repo.defaultBranch,
        title: cs.title,
        body,
        draft: cs.status === 'tests_failed',
      });
      await withTenant(organizationId, (tx) =>
        tx.changeset.update({
          where: { id: cs.id },
          data: {
            prNumber: pr.number,
            prUrl: pr.url,
            status: cs.status === 'tests_failed' ? cs.status : 'pr_open',
            updatedAt: new Date(),
          },
        }),
      );
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        changesetId: cs.id,
        type: 'CHANGESET_OPENED',
        actor: { kind: 'system' },
        payload: { prNumber: pr.number, prUrl: pr.url, branch: cs.branch },
      });
    } catch (e: any) {
      logger.warn(
        { changesetId: cs.id, err: e?.message ?? e },
        'auto-open-pr: failed; leaving changeset as-is',
      );
    }
  }
}

/**
 * Trigger the configured dev DeployTarget for each changeset whose PR is
 * open and doesn't yet have a Deploy row. Persists Deploy + sets
 * `Changeset.devDeployId` and status `dev_deployed` (optimistic — we
 * record the trigger; webhooks/poller flip the status if it fails).
 */
async function triggerPendingDevDeploys(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  deploy: DeployProvider;
  deployTarget: { id: string; kind: string; adapterId: string; config: unknown };
  eventlog: Eventlog;
  logger: Logger;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, deploy, deployTarget, eventlog, logger } = opts;

  const changesets = await withTenant(organizationId, (tx) =>
    tx.changeset.findMany({
      where: {
        dailyRunId: runId,
        prNumber: { not: null },
        devDeployId: null,
        status: { in: ['pr_open', 'tests_failed'] },
      },
    }),
  );
  if (changesets.length === 0) return;

  const targetRef = {
    id: deployTarget.id,
    kind: deployTarget.kind as 'dev' | 'staging' | 'prod',
    adapterId: deployTarget.adapterId,
    config: (deployTarget.config ?? {}) as Record<string, unknown>,
  };

  for (const cs of changesets) {
    const correlationId = `${cs.id}-${Date.now()}`;
    try {
      const handle = await deploy.triggerDeploy(targetRef, {
        ref: cs.branch,
        branch: cs.branch,
        correlationId,
      });
      const url = await deploy
        .resolveUrlForRef(targetRef, cs.branch)
        .catch(() => null);

      const dep = await withTenant(organizationId, (tx) =>
        tx.deploy.create({
          data: {
            organizationId,
            projectId,
            changesetId: cs.id,
            deployTargetId: deployTarget.id,
            ref: cs.branch,
            correlationId,
            externalRunId: handle.externalRunId,
            url: url ?? null,
            status: 'queued',
            startedAt: new Date(),
          },
        }),
      );

      await withTenant(organizationId, (tx) =>
        tx.changeset.update({
          where: { id: cs.id },
          data: {
            devDeployId: dep.id,
            status: cs.status === 'tests_failed' ? cs.status : 'dev_deployed',
            updatedAt: new Date(),
          },
        }),
      );

      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        changesetId: cs.id,
        type: 'CHANGESET_DEV_DEPLOYED',
        actor: { kind: 'system' },
        payload: { deployId: dep.id, externalRunId: handle.externalRunId, url, correlationId },
      });
    } catch (e: any) {
      logger.warn(
        { changesetId: cs.id, err: e?.message ?? e },
        'auto-deploy-dev: failed; leaving changeset as-is',
      );
    }
  }
}

function buildPrBody(cs: { title: string; whyParagraph: string | null; testSummary: unknown; id: string }): string {
  const lines: string[] = [];
  lines.push(`<!-- Mergecrew changeset ${cs.id} -->`);
  lines.push('');
  lines.push(`## ${cs.title}`);
  lines.push('');
  if (cs.whyParagraph) {
    lines.push('### Why');
    lines.push('');
    lines.push(cs.whyParagraph);
    lines.push('');
  }
  if (cs.testSummary) {
    const ts = cs.testSummary as { passed?: number; failed?: number; suites?: Array<{ name: string; passed: number; failed: number }> };
    lines.push('### Tests');
    lines.push('');
    lines.push(`Total: ${ts.passed ?? 0} passed, ${ts.failed ?? 0} failed`);
    if (ts.suites && ts.suites.length > 0) {
      lines.push('');
      for (const s of ts.suites) {
        lines.push(`- \`${s.name}\` — ${s.passed} passed, ${s.failed} failed`);
      }
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('_Authored by a Mergecrew agent. Review and promote, defer, or rollback in the daily digest._');
  return lines.join('\n');
}

const BUILD_TEST_SKILLS = new Set([
  'build.run_typecheck',
  'build.run_lint',
  'build.run_unit_tests',
  'build.run_integration_tests',
]);

/**
 * Update the active Changeset's testSummary after a build/test skill runs.
 * Status transitions:
 *   - on entry from `proposed`: → `building` (a build has started)
 *   - if skill failed or output indicates failures: → `tests_failed`
 *   - if skill succeeded: → `testing` (PR-open will advance to pr_open)
 * The "active" changeset is the most recent non-terminal one for this run.
 */
async function recordBuildResult(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  skillName: string;
  output: { stdout?: string; stderr?: string; exitCode?: number } | null;
  isError: boolean;
  eventlog: Eventlog;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, skillName, output, isError, eventlog } = opts;
  const cs = await withTenant(organizationId, (tx) =>
    tx.changeset.findFirst({
      where: {
        dailyRunId: runId,
        status: { in: ['proposed', 'building', 'testing', 'tests_failed'] },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  );
  if (!cs) return; // no active changeset yet (build ran before any commit)

  const counts = parseTestOutput(skillName, output?.stdout ?? '', output?.stderr ?? '');
  const failed = isError || (output?.exitCode !== undefined && output.exitCode !== 0) || counts.failed > 0;
  const merged = mergeIntoSummary(cs.testSummary as TestSummary | null, skillName, counts);

  const nextStatus = failed ? 'tests_failed' : cs.status === 'tests_failed' ? cs.status : 'testing';

  await withTenant(organizationId, (tx) =>
    tx.changeset.update({
      where: { id: cs.id },
      data: { testSummary: merged as any, status: nextStatus, updatedAt: new Date() },
    }),
  );

  await eventlog.emit({
    organizationId,
    projectId,
    dailyRunId: runId,
    workflowRunId,
    changesetId: cs.id,
    type: failed ? 'CHANGESET_TESTS_FAILED' : 'CHANGESET_TESTS_PASSED',
    actor: { kind: 'system' },
    payload: { skillName, counts },
  });
}

function splitCommitMessage(msg: string): { title: string; whyParagraph: string } {
  const trimmed = msg.trim();
  if (!trimmed) return { title: '', whyParagraph: '' };
  const blank = trimmed.indexOf('\n\n');
  if (blank < 0) return { title: trimmed, whyParagraph: '' };
  return {
    title: trimmed.slice(0, blank).trim(),
    whyParagraph: trimmed.slice(blank + 2).trim(),
  };
}

async function checkDailyBudget(
  organizationId: string,
): Promise<{ exceeded: boolean; spent: number; budget: number | null }> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findUnique({ where: { id: organizationId } }),
  );
  const budget =
    org?.dailyBudgetUsd === null || org?.dailyBudgetUsd === undefined
      ? null
      : Number(org.dailyBudgetUsd);
  if (budget === null) return { exceeded: false, spent: 0, budget: null };
  const agg = await withTenant(organizationId, (tx) =>
    tx.llmInvocation.aggregate({
      where: { organizationId, occurredAt: { gte: since } },
      _sum: { usdEstimate: true },
    }),
  );
  const spent = Number(agg._sum.usdEstimate ?? 0);
  return { exceeded: spent >= budget, spent, budget };
}

async function nextSequence(kind: 'model' | 'tool', stepId: string): Promise<number> {
  // Naive: count existing rows. With high contention switch to an advisory-locked counter.
  const c = await (await import('@mergecrew/db')).withSystem(async (tx) => {
    if (kind === 'model') return tx.modelTurn.count({ where: { agentStepId: stepId } });
    return tx.toolCall.count({ where: { agentStepId: stepId } });
  });
  return c + 1;
}

async function synthesizeAgentInput(
  organizationId: string,
  projectId: string,
  runId: string,
  agentRef: string,
  _cfg: MergecrewConfig,
): Promise<unknown> {
  // Pull recent intent inbox + recent issues + last digest to seed the Discovery agent.
  if (agentRef === 'discovery') {
    const intents = await withTenant(organizationId, (tx) =>
      tx.intentInboxItem.findMany({
        where: { projectId, status: 'queued' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    );
    return {
      runId,
      intents: intents.map((i) => ({ id: i.id, body: i.body, submittedAt: i.createdAt.toISOString() })),
    };
  }
  if (agentRef === 'pm') {
    return { runId, instruction: 'Translate discovery output into 1–3 prioritized intents with one-paragraph specs.' };
  }
  return { runId, instruction: `You are the ${agentRef} agent. Plan and execute your scoped task.` };
}
