import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import {
  type AgentDefinition,
  type MergecrewConfig,
  type ModelCapability,
  type StepOutcome,
} from '@mergecrew/domain';
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
    },
  });

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
