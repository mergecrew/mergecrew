import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import { effectiveBaseBranch, withTenant } from '@mergecrew/db';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AutoPromoteRule,
  autoPromoteMatches,
  checkBlastRadius,
  clampBudgetForRun,
  computeRiskScore,
  parsePackageJsonDiff,
  resolveAgentByRef,
  type AgentDefinition,
  type AutoPromoteRule as AutoPromoteRuleType,
  type BlastRadiusLimits,
  type MergecrewConfig,
  type ModelCapability,
  type PackageJsonVersionChange,
  type StepOutcome,
  type TestSummary,
} from '@mergecrew/domain';

const execFileAsync = promisify(execFile);
import { parseTestOutput, mergeIntoSummary } from './test-summary.js';
import { computeRiskChip, type RiskLevel } from './risk-chip.js';
import { Eventlog } from '@mergecrew/eventlog';
import {
  CapabilityRouter,
  CircuitBreaker,
  ProviderRegistry,
  chat as chatLlm,
  estimateUsd,
  priceFor,
  type LlmProfile,
} from '@mergecrew/llm';
import { stockSkills, buildHttpSkill, SkillExecutor, type SkillExecutionContext } from '@mergecrew/skills';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';
import { GitHubProvider, getGitHubAppCredentials, type VcsProvider } from '@mergecrew/adapters-vcs';
import {
  AwsDirectProvider,
  ExternalCiProvider,
  GitHubActionsProvider,
  VercelProvider,
  NetlifyProvider,
  RenderProvider,
  type DeployProvider,
} from '@mergecrew/adapters-deploy';
import { LinearProvider, GitHubIssuesProvider, type TrackerProvider } from '@mergecrew/adapters-tracker';

const TRACKER_TOKEN_SECRET = 'TRACKER_TOKEN';
const ERROR_TRACKER_TOKEN_SECRET = 'ERROR_TRACKER_TOKEN';
import { CompositeCommsProvider, emailConfigFromEnv } from '@mergecrew/adapters-comms';
import {
  runAgentStep,
  BudgetTracker,
  PolicyEngine,
  PLANNER_AGENT_KIND,
  CODER_AGENT_KIND,
  REVIEWER_AGENT_KIND,
  PM_AGENT_KIND,
  BACKEND_ENGINEER_AGENT_KIND,
  FRONTEND_ENGINEER_AGENT_KIND,
  QA_AGENT_KIND,
  SRE_AGENT_KIND,
  DESIGN_REVIEWER_AGENT_KIND,
  OBSERVATION_AGENT_KIND,
  BUG_TRIAGE_AGENT_KIND,
  DOC_WRITER_AGENT_KIND,
  PLANNER_DISCOVERY_SYSTEM_PROMPT,
  parseBugTriageReport,
  parseDesignReviewVerdict,
  parseDocWriterReport,
  parseObservationReport,
  parsePlanPaths,
  parsePlannerDirections,
  parsePmSpec,
  parseQaVerdict,
  parseReviewerVerdict,
  type ParsedPmSpec,
  type PmSpecTarget,
} from '@mergecrew/agent-runtime';
import { transcriptStoreFromEnv } from '@mergecrew/transcript-store';
import type { CancellationCoordinator } from './cancellation.js';
import {
  workspaceRoot as resolveWorkspaceRoot,
  workspacePathForRun,
  bootstrapWorkspace,
} from './workspace.js';
import { resolveSandboxResources } from './runner-config.js';
import { maybeRunMiseInstall } from './mise-install.js';
import { maybeBuildDevcontainer } from './devcontainer-build.js';
import { maybeRunSetup } from './setup-script.js';
import { resolveCacheMounts } from './cache-mounts.js';

interface StepArgs {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentRef: string;
  eventlog: Eventlog;
  logger: Logger;
  /**
   * Optional in V1.3: when present, the runner registers the step's
   * AbortController so an external `run-cancel` pubsub message can stop it
   * mid-flight. Tests that exercise runStep() in isolation can omit this.
   */
  cancellation?: CancellationCoordinator;
  /**
   * Sandbox driver selected by `RUNNER_SANDBOX`. The runner threads it
   * through the skill execution context so shell-bound skills will (per
   * #560) exec via the driver instead of calling `execa` on the host
   * directly. In #556 the field is plumbed but stock skills don't yet
   * use it.
   */
  driver: SandboxDriver;
}

export async function runStep(args: StepArgs): Promise<StepOutcome> {
  const { organizationId, projectId, runId, workflowRunId, stepId, agentRef, eventlog, logger, cancellation, driver } = args;

  // Defense in depth: a step might have been queued before the user
  // cancelled the run. Don't waste an LLM call on it. The orchestrator
  // also checks at dispatch, but a queued job that was already in flight
  // when the user clicked cancel still arrives here.
  const runRow = await withTenant(organizationId, (tx) =>
    tx.dailyRun.findUnique({ where: { id: runId }, select: { status: true } }),
  );
  if (runRow?.status === 'cancelled') {
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { status: 'cancelled', finishedAt: new Date(), heartbeatAt: null },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'AGENT_STEP_FAILED',
      actor: { kind: 'system' },
      payload: { reason: 'run_cancelled', agentRef },
    });
    return { kind: 'cancelled' };
  }

  await withTenant(organizationId, (tx) =>
    tx.agentStep.update({
      where: { id: stepId },
      data: {
        status: 'running',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        attempt: { increment: 1 },
      },
    }),
  );

  // Liveness heartbeat (V1.4 dead-runner recovery, #10). The orchestrator's
  // sweeper re-dispatches steps whose heartbeat goes stale on the assumption
  // the runner died. We tick every 15s by default — well under the sweeper's
  // 90s staleness threshold so a brief DB hiccup doesn't trigger recovery.
  const heartbeatIntervalMs = Number(process.env.RUNNER_HEARTBEAT_INTERVAL_MS ?? 15_000);
  const heartbeatTimer = setInterval(() => {
    withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { heartbeatAt: new Date() },
      }),
    ).catch((err: any) =>
      logger.warn({ stepId, err: err?.message ?? err }, 'heartbeat write failed'),
    );
  }, heartbeatIntervalMs);
  // Don't keep the process alive just for the heartbeat.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  const stopHeartbeat = () => clearInterval(heartbeatTimer);
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
  // Resolution order: lifecycle agents → stock fallback (planner/coder/
  // reviewer for careful-profile projects whose lifecycle YAML doesn't
  // define them) → empty stub for V1 single-agent agentRefs like
  // 'discovery'/'pm'/etc. Keeping all three in one place so the runner
  // never has to know about graphProfile directly.
  const agentDef = (resolveAgentByRef(cfg.agents, agentRef) ?? {
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

  // Per-run shared workspace. In dev defaults to a tmp dir; in prod set
  // RUNNER_WORKSPACE_ROOT to an ephemeral, writable location (e.g. the
  // container's /var/mergecrew/work mount).
  //
  // One workspace per dailyRun — the first step in a run clones the
  // connected repo into it; subsequent steps reuse the same working tree
  // (so the coder sees the planner's branch, the reviewer sees the
  // coder's diff, etc). Cleanup is run-terminal: orchestrator.completeRun
  // and api.cancel enqueue a `runner.workspace-cleanup` job that rms the
  // directory once the run reaches a terminal state.
  //
  // mode 0700: the workspace contains decrypted secrets, the repo
  // checkout, and tool outputs — none readable to other users on the
  // host. `recursive: true` only sets the mode on the leaf, so we mkdir
  // the root with the same mode first to lock the whole chain.
  await fs.mkdir(resolveWorkspaceRoot(), { recursive: true, mode: 0o700 });
  const workspacePath = workspacePathForRun(runId);
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });

  // Resolve per-project image + resources from the lifecycle yaml
  // (#559). When the project leaves the `runner` block empty the driver
  // falls back to its supervisor-level defaults. The lifecycle row is
  // re-read below for agent / gate resolution, but we need the runner
  // block before driver.start() so the docker driver gets the right
  // image on container create.
  const earlyLifecycle = await withTenant(organizationId, (tx) =>
    tx.lifecycle.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { parsed: true },
    }),
  );
  const earlyCfg = (earlyLifecycle?.parsed ?? {}) as MergecrewConfig;
  const sandboxResources = resolveSandboxResources(earlyCfg.runner);

  // Image resolution (#570 + #559): if the project ships
  // `.devcontainer/devcontainer.json` and the supervisor can build it,
  // that image wins over `runner.image` from mergecrew.yaml. Stock
  // catalog detection (#566) is downstream of both — handled by the
  // driver when neither is set. Build failures fall back transparently.
  //
  // We bootstrap the workspace (clone) BEFORE this hook so the
  // devcontainer file is present on disk.
  let sandboxImage: string | undefined = earlyCfg.runner?.image;

  // Per-project cache mounts (#572). Resolves runner.cache.paths to
  // host-side directories tagged by (org_id, project_id); the driver
  // mounts each into the container. ProcessDriver ignores them.
  const cacheMounts = await resolveCacheMounts({
    organizationId,
    projectId,
    cachePaths: earlyCfg.runner?.cache?.paths,
  }).catch((err: any) => {
    logger.warn({ err: err?.message ?? err }, 'cache mounts resolution failed; continuing without persistent caches');
    return [];
  });

  // Egress allowlist for the sandbox network layer (#573). Pulled
  // from `runner.egress.allow` in mergecrew.yaml. When set + a custom
  // egress network is configured on the supervisor, the driver flips
  // from `--network none` to the operator-provisioned network whose
  // nftables ruleset accepts traffic to these hosts only.
  const sandboxEgressAllow = earlyCfg.runner?.egress?.allow ?? null;

  // Start the per-step sandbox (#556, #559, #572, #573). Provisions a
  // per-run container with image + resources + cache mounts + egress
  // posture resolved above. Skills exec shell via the handle on
  // SkillExecutionContext.
  const sandbox: SandboxHandle = await driver.start({
    runId,
    projectId,
    organizationId,
    workspacePath,
    image: sandboxImage,
    resources: sandboxResources,
    cacheMounts,
    egressAllowlist: sandboxEgressAllow,
  });

  // VCS adapter from env (used by the workspace bootstrap below and by
  // skills that touch the repo).
  const ghCreds = getGitHubAppCredentials();
  let vcs: VcsProvider | undefined;
  if (ghCreds) {
    vcs = new GitHubProvider(ghCreds);
  }

  // Workspace bootstrap (idempotent, runs once per dailyRun). The first
  // step to land for this run finds an empty workspace and clones the
  // connected repo; subsequent steps see `.git` and skip. Fail fast when
  // there is no ConnectedRepo (or no GitHub App creds) — an agent can't
  // plan or code against a phantom repo, and silently planning over an
  // empty workspace is what produced the original "0 paths" symptom.
  //
  // Stub / demo mode (#191, #374) short-circuits the LLM and returns
  // canned outcomes inside `runAgentStep`. Those paths don't read the
  // workspace at all, so the bootstrap (which requires a real
  // ConnectedRepo + GitHub App creds) is bypassed. This is what keeps
  // the e2e-loop smoke test and the demo-mode "Run now" button working
  // against the seeded demo project, which has no real repo connection.
  const stubMode =
    process.env.MERGECREW_AGENT_STUB === '1' ||
    process.env.MERGECREW_DEMO_MODE === '1';
  const bootstrap = stubMode
    ? ({ kind: 'reused' } as const)
    : await bootstrapWorkspace({
        workspacePath,
        vcs,
        fetchConnectedRepo: async () => {
          const row = await withTenant(organizationId, (tx) =>
            tx.connectedRepo.findUnique({ where: { projectId } }),
          );
          if (!row) return null;
          return {
            installationId: row.installationId,
            repoId: row.repoId,
            repoFullName: row.repoFullName,
            defaultBranch: effectiveBaseBranch(row),
          };
        },
        logger,
      });
  if (bootstrap.kind === 'failed') {
    const failureReason =
      bootstrap.reason === 'clone_failed'
        ? `clone_failed: ${bootstrap.message.slice(0, 500)}`
        : bootstrap.reason;
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: {
          status: 'failed',
          failureReason,
          finishedAt: new Date(),
          heartbeatAt: null,
        },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'AGENT_STEP_FAILED',
      actor: { kind: 'system' },
      payload: { reason: bootstrap.reason, agentRef, message: bootstrap.message },
    });
    stopHeartbeat();
    return { kind: 'failed', reason: bootstrap.reason };
  }

  // Devcontainer build (#570). When the cloned workspace contains
  // .devcontainer/devcontainer.json, build it into an OCI image and
  // promote that image to be the sandbox image. Cached on host by
  // config hash; failures fall back to the explicit runner.image or
  // the driver's default.
  const devcontainer = await maybeBuildDevcontainer({ workspacePath, logger }).catch(
    (err: any) => ({ kind: 'failed' as const, reason: String(err?.message ?? err) }),
  );
  if (devcontainer.kind === 'built' || devcontainer.kind === 'cached') {
    sandboxImage = devcontainer.image;
  }
  // sandbox already started above with the previous image — for the
  // devcontainer to actually be the sandbox's image, we'd need to
  // restart it. In this iteration the build is precomputed so the
  // NEXT step in the same run uses it; the first step pays the
  // stock-image cost. A follow-up (small) can move the build hook
  // before driver.start() once the bootstrap+driver lifecycle is
  // restructured. For now: log and surface.
  void sandboxImage;

  // Bootstrap project toolchain via mise (#568). No-op when there's
  // no .tool-versions / .mise.toml or when the sentinel matches the
  // current hash. Failure is non-fatal: we log + continue so an
  // operator without mise in their image still gets a chance to run
  // the agent loop (build skills will fall back to whatever's on PATH).
  await maybeRunMiseInstall({
    workspacePath,
    driver,
    sandbox,
    logger,
    abortSignal: undefined,
  }).catch((err: any) =>
    logger.warn({ workspacePath, err: err?.message ?? err }, 'mise install hook threw'),
  );

  // Run the project's `runner.setup` commands (#572). Sentinel-deduped
  // so the same setup doesn't re-run across steps in the same workspace.
  await maybeRunSetup({
    workspacePath,
    driver,
    sandbox,
    setup: earlyCfg.runner?.setup,
    logger,
    abortSignal: undefined,
  }).catch((err: any) =>
    logger.warn({ workspacePath, err: err?.message ?? err }, 'runner.setup hook threw'),
  );

  // Deploy adapter selection: pick the dev target, decide adapter from its config.
  const dt = await withTenant(organizationId, (tx) =>
    tx.deployTarget.findFirst({ where: { projectId, kind: 'dev' } }),
  );
  let deploy: DeployProvider | undefined;
  if (dt?.adapterId === 'external-ci') {
    // No vendor token / API call — adapter is a passthrough that returns
    // the configured URL. Always selectable; needs no env (#467).
    deploy = new ExternalCiProvider();
  } else if (dt?.adapterId === 'github-actions' && ghCreds) {
    deploy = new GitHubActionsProvider(ghCreds);
  } else if (dt?.adapterId === 'vercel' && process.env.VERCEL_TOKEN) {
    deploy = new VercelProvider({ token: process.env.VERCEL_TOKEN });
  } else if (dt?.adapterId === 'netlify' && process.env.NETLIFY_TOKEN) {
    deploy = new NetlifyProvider({ token: process.env.NETLIFY_TOKEN });
  } else if (dt?.adapterId === 'render' && process.env.RENDER_TOKEN) {
    deploy = new RenderProvider({ token: process.env.RENDER_TOKEN });
  } else if (dt?.adapterId === 'aws-direct') {
    // Static keys are optional — when absent the SDK uses the default
    // credential chain (env vars, IMDS, shared config). Operators with
    // role-based deploys pre-assume the role and pass the temporary
    // credentials in via the AWS_* env vars; this adapter doesn't manage
    // STS itself.
    deploy = new AwsDirectProvider({
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    });
  }

  // Tracker adapter — per-project. Reads tracker_targets + the encrypted
  // TRACKER_TOKEN secret. If either is missing we leave it undefined so skills
  // that need a tracker can fail with a clear message.
  //
  // GitHub Issues fast-path (#550): when the tracker is github-issues
  // and no TRACKER_TOKEN secret is stored, mint a fresh installation
  // token via the same GH App credentials the VCS provider uses.
  // Onboarding auto-creates this TrackerTarget on repo connect so the
  // operator doesn't have to wire up a PAT — Discovery and BugTriage
  // call `tracker.list_issues` on every run, and unconfigured trackers
  // surface as red dots in the timeline.
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
    const storedToken = tokenRow ? decryptDevOnly(tokenRow.ciphertext) : null;
    if (trackerTarget.adapterId === 'github-issues') {
      const repoFullName = (trackerTarget.config as any)?.repoFullName ?? '';
      if (repoFullName) {
        let issuesToken = storedToken;
        if (!issuesToken && vcs instanceof GitHubProvider) {
          // Fall back to the GH App installation token. Same credential
          // the VCS provider mints for clone/PR; same scopes cover the
          // Issues API.
          const repo = await withTenant(organizationId, (tx) =>
            tx.connectedRepo.findUnique({ where: { projectId } }),
          );
          if (repo) {
            issuesToken = await vcs
              .getInstallationToken(repo.installationId)
              .catch(() => null);
          }
        }
        if (issuesToken) {
          tracker = new GitHubIssuesProvider({
            installationToken: issuesToken,
            repoFullName,
          });
        }
      }
    } else if (trackerTarget.adapterId === 'linear' && storedToken) {
      tracker = new LinearProvider({ apiKey: storedToken });
    }
  }

  const comms = new CompositeCommsProvider({
    email: emailConfigFromEnv(),
  });

  // Error-tracker config — per-project. Reads error_targets + the encrypted
  // ERROR_TRACKER_TOKEN secret. Plumbed into ctx.config.sentry so the
  // `errors.list_recent` skill can call the upstream API. Missing rows are
  // soft-failed: the skill returns `{issues: []}` when not configured.
  let sentryConfig: { token: string; org: string; project: string } | undefined;
  const errorTarget = await withTenant(organizationId, (tx) =>
    tx.errorTarget.findUnique({ where: { projectId } }),
  );
  if (errorTarget) {
    const tokenRow = await withTenant(organizationId, (tx) =>
      tx.projectSecret.findFirst({
        where: { projectId, name: ERROR_TRACKER_TOKEN_SECRET },
      }),
    );
    if (tokenRow && errorTarget.adapterId === 'sentry') {
      const token = decryptDevOnly(tokenRow.ciphertext);
      const cfg = errorTarget.config as { org?: string; project?: string };
      if (cfg.org && cfg.project) {
        sentryConfig = { token, org: cfg.org, project: cfg.project };
      }
    }
  }

  const skills = new SkillExecutor();
  skills.registerAll(stockSkills);
  for (const [name, def] of Object.entries(cfg.skills ?? {})) {
    skills.register(buildHttpSkill(name, def));
  }

  // Read the project's egress allowlist (#10) and dry-run flag (#284).
  // egressAllowlist NULL = no restriction (back-compat); the skill
  // execution layer honors the value as-is.
  // dryRun TRUE = produce a changeset but skip the VCS push, PR-open
  // and deploy stages so the operator can review without remote
  // side-effects.
  const projectRow = await withTenant(organizationId, (tx) =>
    tx.project.findUnique({
      where: { id: projectId },
      select: { egressAllowlist: true, dryRun: true },
    }),
  );
  const egressAllowlist = (projectRow?.egressAllowlist as string[] | null | undefined) ?? null;
  const dryRun = projectRow?.dryRun ?? false;

  const policy = new PolicyEngine({
    agentDoNotTouch: agentDef.do_not_touch,
    projectSensitivePatterns: cfg.lifecycle?.human_gates?.sensitive_path_patterns ?? [],
    projectHardBlocked: ['**/.env*'],
  });

  // Per-kind run budget enforcement (#351). When the agentDef declares
  // a `runBudget`, clamp this step's effective budget so cumulative
  // spend by this kind across the workflow run stays under the cap. A
  // kind that's already at/over its runBudget gets an exhausted
  // tracker — the step short-circuits to budget_exhausted before any
  // model turn fires.
  const effectiveBudgetSpec = await computeEffectiveBudget({
    organizationId,
    workflowRunId,
    agentKind: agentDef.kind,
    perStep: agentDef.budget,
    runBudget: agentDef.runBudget,
  });
  const budget = new BudgetTracker(effectiveBudgetSpec);
  const abortController = new AbortController();
  // Hook into the runner-wide cancellation coordinator so a `run-cancel`
  // pubsub message aborts this step mid-flight. The agent runtime already
  // returns `{ kind: 'cancelled' }` when the signal fires.
  const unregisterCancellation = cancellation?.register(runId, abortController);

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
    egressAllowlist,
    driver,
    sandbox,
    config: {
      // Per-skill / per-step config bag the runner injects.
      adapterConfig: dt?.config ?? {},
      ...(sentryConfig ? { sentry: sentryConfig } : {}),
      // Provider-routed LLM closure for skills that need to think (summarize,
      // draft spec, design review, …). The closure resolves a model that
      // satisfies the optional `requireVision` capability via the existing
      // CapabilityRouter and forwards messages through `chat()` so the
      // vision preflight (#112) and BudgetTracker boundaries still apply.
      llm: {
        chat: async (req: {
          messages: any[];
          maxTokens?: number;
          temperature?: number;
          requireVision?: boolean;
        }) => {
          const need = req.requireVision ? { vision: true as const } : {};
          const resolved = router.resolve({ capability: need, profile, agentKind: agentDef.kind });
          const r = await chatLlm({
            registry,
            providerId: resolved.providerId,
            modelId: resolved.modelId,
            messages: req.messages as any,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            signal: abortController.signal,
          });
          return {
            text: r.content,
            usage: { totalTokens: r.usage.totalTokens ?? 0 },
            providerId: r.providerId,
            modelId: r.modelId,
          };
        },
      },
    },
  });

  // Hard spend gates. Daily budget and monthly cap (#282) are both
  // checked once at step entry — not per-iteration — so a single step
  // can't be more than one model turn over either limit. Monthly cap
  // takes priority in the log message because it's the harder ceiling.
  const [budgetGate, monthlyGate] = await Promise.all([
    checkDailyBudget(organizationId),
    checkMonthlyCap(organizationId),
  ]);
  if (monthlyGate.exceeded) {
    stopHeartbeat();
    unregisterCancellation?.();
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'AGENT_STEP_FAILED',
      actor: { kind: 'system' },
      payload: {
        reason: 'org_monthly_cap_exceeded',
        spentUsd: monthlyGate.spent,
        capUsd: monthlyGate.cap,
      },
    });
    return {
      kind: 'budget_exhausted',
      reason: `org monthly spend cap exhausted: spent $${monthlyGate.spent.toFixed(2)} of $${monthlyGate.cap?.toFixed(2)}`,
    };
  }
  if (budgetGate.exceeded) {
    stopHeartbeat();
    unregisterCancellation?.();
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

  const initialInput = await synthesizeAgentInput(organizationId, projectId, runId, agentRef, agentDef, cfg);
  // Discovery-mode planner (#492): swap the system prompt so the
  // planner explores instead of asking "what task?". Detected from the
  // input shape rather than re-querying the DB. The mutation is
  // step-scoped — agentDef is rebuilt by the caller on each step.
  const isPlannerDiscovery =
    agentDef.kind === PLANNER_AGENT_KIND &&
    typeof initialInput === 'object' &&
    initialInput !== null &&
    (initialInput as { mode?: string }).mode === 'discovery';
  if (isPlannerDiscovery) {
    agentDef.systemPrompt = PLANNER_DISCOVERY_SYSTEM_PROMPT;
  }

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
      // Synchronous wait would tie up a runner slot indefinitely. Instead
      // hand control back to the orchestrator with the approval id; it
      // pauses the run and re-dispatches this same step once a human
      // resolves the approval.
      return { pending: true, approvalId: ar.id };
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
          isDryRun: dryRun,
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

  // Coder agents (#333) get an out-of-scope edit guard. After the
  // step finishes, we compare the file paths touched by any changesets
  // produced in this run against the planner's "Files to touch" list.
  // Out-of-scope paths emit an AGENT_DECISION event so the reviewer
  // agent (this issue) can pick it up via synthesizeAgentInput's
  // outOfScopeHints field.
  if (agentDef.kind === CODER_AGENT_KIND && outcome.kind === 'completed') {
    await emitOutOfScopeIfAny({
      organizationId,
      projectId,
      runId,
      workflowRunId,
      stepId,
      agentKind: agentDef.kind,
      eventlog,
    });
    // Demo-mode synthesis (#373). The stub coder doesn't invoke
    // `repo.write_file` / `repo.git.commit`, so no Changeset row gets
    // created via the normal skill path. Without one, the careful
    // flow advances past the Coder with nothing for the Reviewer to
    // look at and nothing for the human reviewer to see in the
    // Changesets list. Synthesize a placeholder here so demo runs
    // produce visible artifacts. Activated by either AGENT_STUB
    // (existing e2e gate) or DEMO_MODE (#374) — they share a
    // backend.
    if (
      process.env.MERGECREW_AGENT_STUB === '1' ||
      process.env.MERGECREW_DEMO_MODE === '1'
    ) {
      await synthesizeStubChangeset({
        organizationId,
        projectId,
        runId,
        workflowRunId,
        stepId,
        eventlog,
      });
    }
  }

  // Reviewer agents (#334) emit REVIEW_APPROVED or
  // REVIEW_CHANGES_REQUESTED based on parsing the structured verdict
  // out of the agent's final text message. Malformed output is
  // treated as request_changes so a parser failure can't accidentally
  // approve a bad diff. The graph wiring that consumes these events
  // to drive the planner → coder → reviewer loop lives in #336.
  if (
    agentDef.kind === REVIEWER_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseReviewerVerdict(outcome.output);
    const verdict = parsed?.verdict ?? 'request_changes';
    // When the parser bails the safe default is `request_changes`, but
    // returning an empty reasoning makes the coder retry blind. Pass the
    // raw reviewer text through (truncated) so the retry has substance
    // to work from — without it the review→code loop dead-spirals at
    // the cap with no actual feedback.
    const reasoning =
      parsed?.reasoning ??
      `reviewer output did not match the expected verdict shape; raw output below:\n\n${outcome.output.slice(0, 2000)}`;
    const requestedChanges = parsed?.requestedChanges ?? [];
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { verdict, reasoning, requestedChanges } as any },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: verdict === 'approve' ? 'REVIEW_APPROVED' : 'REVIEW_CHANGES_REQUESTED',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: { reasoning, requestedChanges },
    });

    // Post the reviewer agent's verdict as a native PR review (#420, V2.al)
    // and, on approve, flip the draft to ready-for-review. Best-effort:
    // a failure here is logged but never blocks run progression. We only
    // act when there's a connected GitHub repo and the changeset has a
    // PR — the dry-run / local-adapter / no-PR-yet paths all short-circuit
    // here automatically.
    if (vcs) {
      try {
        const repo = await withTenant(organizationId, (tx) =>
          tx.connectedRepo.findUnique({ where: { projectId } }),
        );
        const cs = await withTenant(organizationId, (tx) =>
          tx.changeset.findFirst({
            where: { dailyRunId: runId, prNumber: { not: null } },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, prNumber: true, prUrl: true },
          }),
        );
        if (repo && cs?.prNumber) {
          const repoRef = {
            installationId: repo.installationId,
            repoId: repo.repoId ?? undefined,
            repoFullName: repo.repoFullName,
            defaultBranch: effectiveBaseBranch(repo),
          };
          const reviewBody =
            verdict === 'approve'
              ? reasoning
              : reasoning +
                (requestedChanges.length > 0
                  ? '\n\n**Requested changes:**\n' +
                    requestedChanges.map((c) => `- ${c}`).join('\n')
                  : '');
          await vcs.postReview(repoRef, cs.prNumber, {
            event: verdict === 'approve' ? 'approve' : 'request_changes',
            body: reviewBody,
          });
          if (verdict === 'approve') {
            await vcs.markReadyForReview(repoRef, cs.prNumber).catch((err: unknown) => {
              // Already-ready PRs throw from the GraphQL mutation; that's
              // not an error, just a no-op state. Log at info, not warn.
              logger.info(
                { err: (err as Error)?.message ?? err, prNumber: cs.prNumber },
                'review: markReadyForReview returned non-fatal error (PR may already be ready)',
              );
            });
          }
          await eventlog.emit({
            organizationId,
            projectId,
            dailyRunId: runId,
            workflowRunId,
            agentStepId: stepId,
            changesetId: cs.id,
            type: 'CHANGESET_REVIEW_POSTED',
            actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
            payload: {
              prNumber: cs.prNumber,
              prUrl: cs.prUrl,
              verdict,
              flippedToReady: verdict === 'approve',
            },
          });
        }
      } catch (err: unknown) {
        logger.warn(
          { err: (err as Error)?.message ?? err, runId },
          'review: failed to post reviewer verdict to PR; agent loop continues',
        );
      }
    }
  }

  // Planner agents (#332) persist their final markdown plan on
  // agent_steps.output and emit PLAN_PROPOSED so downstream agents
  // (coder, reviewer) and the timeline UI can consume it. We only
  // persist on a clean `completed` outcome — partial outcomes
  // (failed/budget_exhausted/cancelled) leave the field null because
  // a truncated plan is worse than no plan for the coder's purposes.
  //
  // Discovery mode (#492) splits the path: the planner produced three
  // candidate directions, not a plan. Persist `{ mode: 'discovery',
  // directions }` instead of `{ planMarkdown }` and emit
  // PLANNER_DIRECTIONS_PROPOSED. The orchestrator routes on
  // `output.mode === 'discovery'` to terminate the chain.
  if (
    agentDef.kind === PLANNER_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string' &&
    outcome.output.trim().length > 0
  ) {
    const markdown = outcome.output.trim();
    if (isPlannerDiscovery) {
      const directions = parsePlannerDirections(markdown);
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { output: { mode: 'discovery', directions, markdown } as any },
        }),
      );
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'PLANNER_DIRECTIONS_PROPOSED',
        actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
        payload: { directions, markdown },
      });
    } else {
      const planMarkdown = markdown;
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: { output: { planMarkdown } as any },
        }),
      );
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'PLAN_PROPOSED',
        actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
        payload: { planMarkdown },
      });
    }
  }

  // PM agent post-process (#517, V2.af roster). Parse the spec markdown
  // into the structured shape the engineer agents consume, persist on
  // agent_steps.output, and emit PM_SPEC_PROPOSED. A `SPEC_GAP` output
  // (PM couldn't scope the intent) parses to null — we still persist
  // the raw markdown so the run-detail UI can render what PM said and
  // the operator sees why the chain stopped advancing.
  if (
    agentDef.kind === PM_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string' &&
    outcome.output.trim().length > 0
  ) {
    const markdown = outcome.output.trim();
    const spec: ParsedPmSpec | null = parsePmSpec(markdown);
    const sourceIntentId =
      typeof initialInput === 'object' && initialInput !== null
        ? (initialInput as { intent?: { id?: string } }).intent?.id
        : undefined;
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { spec, markdown, sourceIntentId } as any },
      }),
    );
    if (spec) {
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'PM_SPEC_PROPOSED',
        actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
        payload: { spec, sourceIntentId },
      });
    } else {
      // Parser bailed — most likely a `SPEC_GAP:` response. Surface as
      // a step failure so the orchestrator stops dispatching engineers
      // against an empty spec. The raw markdown is on `output.markdown`
      // for the operator to read in the UI.
      logger.info(
        { stepId, sourceIntentId },
        'pm: spec parser returned null — likely SPEC_GAP; engineers will not be dispatched',
      );
      await eventlog.emit({
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        agentStepId: stepId,
        type: 'AGENT_STEP_FAILED',
        actor: { kind: 'system' },
        payload: {
          reason: 'spec_gap',
          agentRef,
          sourceIntentId,
          message: markdown.slice(0, 1000),
        },
      });
    }
  }

  // QA agent post-process (#520, V2.af roster). Parse the structured
  // verdict out of the agent's final text, persist it on
  // `agent_steps.output` (the orchestrator's dispatchGraphNext already
  // reads `output.verdict` to route tests_pass → deploy_dev vs.
  // tests_fail → pm), and emit QA_VERDICT for the timeline. A parser
  // failure resolves to `tests_fail` with the raw output passed
  // through as the summary so the loop-back has substance to work
  // from — same defensive default as the reviewer parser.
  if (
    agentDef.kind === QA_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseQaVerdict(outcome.output);
    const verdict: 'tests_pass' | 'tests_fail' | 'tests_skipped' =
      parsed?.verdict ?? 'tests_fail';
    const summary =
      parsed?.summary ??
      `qa output did not match the expected verdict shape; raw output below:\n\n${outcome.output.slice(0, 2000)}`;
    const failureExcerpts = parsed?.failureExcerpts ?? [];
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { verdict, summary, failureExcerpts } as any },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'QA_VERDICT',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: { verdict, summary, failureExcerpts },
    });
  }

  // DesignReviewer post-process (#522, V2.af roster). Parse the
  // structured visual-review verdict, persist on agent_steps.output,
  // and emit DESIGN_REVIEW_VERDICT. A parser failure resolves to the
  // no-vision fallback — `looks_correct` with a `vision not available`
  // finding — so a malformed output doesn't surface a false-positive
  // regression chip on the run-detail UI.
  if (
    agentDef.kind === DESIGN_REVIEWER_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseDesignReviewVerdict(outcome.output);
    const verdict: 'looks_correct' | 'visual_regression' = parsed?.verdict ?? 'looks_correct';
    const screenshotUrl = parsed?.screenshotUrl ?? '';
    const findings = parsed?.findings ?? (parsed ? [] : ['vision not available']);
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { verdict, screenshotUrl, findings } as any },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'DESIGN_REVIEW_VERDICT',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: { verdict, screenshotUrl, findings },
    });
  }

  // Observation post-process (#523, V2.af roster). Parse the
  // structured smoke-check report, persist on agent_steps.output,
  // and emit OBSERVATION_REPORT. A parser failure resolves to the
  // no-deploy fallback (`healthy` + zeros + `no dev deploy`) so a
  // malformed agent reply doesn't false-positive a rollback intent.
  if (
    agentDef.kind === OBSERVATION_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseObservationReport(outcome.output);
    const verdict: 'healthy' | 'unhealthy' = parsed?.verdict ?? 'healthy';
    const statusCode = parsed?.statusCode ?? 0;
    const latencyMs = parsed?.latencyMs ?? 0;
    const findings = parsed?.findings ?? (parsed ? [] : ['no dev deploy']);
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { verdict, statusCode, latencyMs, findings } as any },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'OBSERVATION_REPORT',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: { verdict, statusCode, latencyMs, findings },
    });
  }

  // BugTriage post-process (#524, V2.af roster). Parse the JSON
  // report, create one intent_inbox_item per intent (with a
  // sourceKey of `bug-triage:<fingerprint>` for cross-run dedup),
  // persist the report on agent_steps.output, and emit
  // BUG_TRIAGE_REPORT. Same defensive default as the other
  // observation-stage post-processes: parser failure → zero-intent
  // report so a malformed agent reply doesn't silently dead-end.
  if (
    agentDef.kind === BUG_TRIAGE_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseBugTriageReport(outcome.output);
    const errorsScanned = parsed?.scanned ?? 0;
    const intentIds: string[] = [];
    if (parsed) {
      for (const intent of parsed.intents) {
        // sourceKey-based dedup: if a queued intent for this
        // fingerprint already exists in this project, skip it.
        // Prevents tomorrow's BugTriage from re-filing the same
        // fingerprint the operator hasn't picked up yet. The
        // agent's memory-based dedup covers the common case; this
        // is the defense-in-depth check.
        const sourceKey = intent.fingerprint
          ? `bug-triage:${intent.fingerprint}`
          : null;
        if (sourceKey) {
          const existing = await withTenant(organizationId, (tx) =>
            tx.intentInboxItem.findFirst({
              where: { projectId, sourceKey, status: 'queued' },
              select: { id: true },
            }),
          );
          if (existing) continue;
        }
        const body = intent.body
          ? `${intent.title}\n\n${intent.body}`
          : intent.title;
        const row = await withTenant(organizationId, (tx) =>
          tx.intentInboxItem.create({
            data: {
              organizationId,
              projectId,
              body,
              sourceKey,
              status: 'queued',
            },
            select: { id: true },
          }),
        );
        intentIds.push(row.id);
      }
    }
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: {
          output: {
            errorsScanned,
            intentsQueued: intentIds.length,
            intentIds,
          } as any,
        },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'BUG_TRIAGE_REPORT',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: {
        errorsScanned,
        intentsQueued: intentIds.length,
        intentIds,
      },
    });
  }

  // DocWriter post-process (#525, V2.af roster). Parse the structured
  // report, persist on agent_steps.output, and emit DOC_WRITER_REPORT.
  // The actual docs edits live on the sibling commit the agent
  // produced via `repo.write_file`; ensureChangesetForCommit records
  // the commit separately. Parser failure resolves to a no-op so a
  // malformed agent reply doesn't false-positive a `docs_updated`
  // signal on the timeline.
  if (
    agentDef.kind === DOC_WRITER_AGENT_KIND &&
    outcome.kind === 'completed' &&
    typeof outcome.output === 'string'
  ) {
    const parsed = parseDocWriterReport(outcome.output);
    const verdict: 'docs_updated' | 'no_op' = parsed?.verdict ?? 'no_op';
    const filesChanged = parsed?.filesChanged ?? [];
    const summary = parsed?.summary ?? '';
    await withTenant(organizationId, (tx) =>
      tx.agentStep.update({
        where: { id: stepId },
        data: { output: { verdict, filesChanged, summary } as any },
      }),
    );
    await eventlog.emit({
      organizationId,
      projectId,
      dailyRunId: runId,
      workflowRunId,
      agentStepId: stepId,
      type: 'DOC_WRITER_REPORT',
      actor: { kind: 'agent', id: stepId, agentKind: agentDef.kind },
      payload: { verdict, filesChanged, summary },
    });
  }

  // After the loop: open PRs for any active changesets that don't have one
  // yet. Best-effort — failures log + leave the changeset in its current
  // status so a follow-up step or human can retry.
  //
  // Dry-run (#284) short-circuits the push/PR/deploy branches: the
  // changeset row still exists (with `isDryRun = true`) and its diff is
  // visible in the UI, but no remote side-effect fires. An operator can
  // later promote the changeset to do the actual push. The dry-run flag
  // on each changeset is enough timeline signal — no extra event emit.
  if (!dryRun && vcs && outcome.kind !== 'failed' && outcome.kind !== 'budget_exhausted') {
    // When the lifecycle includes a Reviewer agent (#420, V2.al), the
    // runner opens the PR as draft and only flips to ready-for-review
    // after the reviewer agent approves. Detected by scanning the
    // lifecycle's agents map for any AgentDefinition with kind ===
    // 'Reviewer' — works for both stock and operator-defined lifecycles.
    const hasReviewerInLifecycle = Object.values(cfg.agents ?? {}).some(
      (a) => (a as AgentDefinition).kind === REVIEWER_AGENT_KIND,
    );
    await openPendingChangesetPrs({
      organizationId,
      projectId,
      runId,
      workflowRunId,
      vcs,
      workspacePath,
      eventlog,
      logger,
      hasReviewerInLifecycle,
    });
  }

  // After PRs are open: trigger the dev-target deploy for each changeset
  // that doesn't already have one. Same best-effort posture as PR opening.
  // Skipped for dry-run runs (no PR means nothing to deploy).
  //
  // Lifecycles with an SRE agent (#521, V2.af roster) own the dev-deploy
  // step explicitly — the SRE post-process below invokes the same helper
  // with the SRE step id stamped on the agent_steps.output row. We skip
  // the auto-trigger here so we don't double-deploy or race with the
  // SRE step's own poll. Careful / fast profiles (no SRE in the
  // lifecycle) fall through to the original behavior.
  const hasSreInLifecycle = Object.values(cfg.agents ?? {}).some(
    (a) => (a as AgentDefinition).kind === SRE_AGENT_KIND,
  );
  if (
    !dryRun &&
    !hasSreInLifecycle &&
    deploy &&
    dt &&
    outcome.kind !== 'failed' &&
    outcome.kind !== 'budget_exhausted'
  ) {
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

  // SRE post-process (#521, V2.af roster). On a completed SRE step,
  // invoke the same `triggerPendingDevDeploys` helper the careful/fast
  // profiles run from the auto-trigger above, then persist the
  // resulting deployment shape on the SRE step's output so the run-
  // detail UI + downstream Observation agent can read what deployed.
  // Best-effort: a deploy failure logs + leaves the changeset's
  // status untouched, mirroring the existing helper's behavior.
  if (
    agentDef.kind === SRE_AGENT_KIND &&
    outcome.kind === 'completed' &&
    !dryRun &&
    deploy &&
    dt
  ) {
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
    const dep = await withTenant(organizationId, (tx) =>
      tx.deploy.findFirst({
        where: { projectId, changeset: { dailyRunId: runId } },
        orderBy: { startedAt: 'desc' },
        select: { url: true, status: true, deployTarget: { select: { adapterId: true } } },
      }),
    );
    if (dep) {
      await withTenant(organizationId, (tx) =>
        tx.agentStep.update({
          where: { id: stepId },
          data: {
            output: {
              deployment: {
                adapterId: dep.deployTarget.adapterId,
                url: dep.url,
                status: dep.status,
              },
            } as any,
          },
        }),
      );
    }
  }

  // Persist the agent transcript to the configured store (#4). Honored
  // outcomes come from runAgentStep; if no transcript was collected
  // (early policy reject before any LLM call) we skip rather than write
  // an empty blob. The transcript URL is stamped on agent_steps so
  // operators can pull the full trace by step id.
  if (outcome.transcript && outcome.transcript.length > 0) {
    const store = transcriptStoreFromEnv();
    if (store) {
      try {
        const url = await store.put(`runs/${runId}/steps/${stepId}.json`, {
          organizationId,
          projectId,
          runId,
          workflowRunId,
          stepId,
          agentRef,
          finishedAt: new Date().toISOString(),
          outcome: {
            kind: outcome.kind,
            reason: outcome.reason,
            toolCallsMade: outcome.toolCallsMade,
            totalTokens: outcome.totalTokens,
          },
          messages: outcome.transcript,
        });
        await withTenant(organizationId, (tx) =>
          tx.agentStep.update({
            where: { id: stepId },
            data: { transcriptUrl: url },
          }),
        );
      } catch (err: any) {
        logger.warn(
          { stepId, err: err?.message ?? err },
          'transcript-store: write failed; agent_steps.transcript_url stays null',
        );
      }
    }
  }

  // Workspace cleanup is run-terminal, not step-terminal — see the
  // `runner.workspace-cleanup` worker. Subsequent steps in this run
  // reuse the same /<workspaceRoot>/<runId>/ tree so the coder can see
  // the planner's branch, the reviewer can see the coder's diff, etc.

  // Stop liveness heartbeat — the step is terminal.
  stopHeartbeat();
  // Unregister from the cancellation coordinator so a stale entry doesn't
  // leak across BullMQ jobs in this process.
  unregisterCancellation?.();
  // Tear the sandbox down. No-op for ProcessDriver; for container drivers
  // (#557) this removes the per-run container. #557 will also need to
  // wrap the whole step in try/finally so early-return paths still call
  // stop() — for now we accept the leak risk because ProcessDriver has
  // no state to leak.
  await driver.stop(sandbox).catch((err: any) =>
    logger.warn({ runId, err: err?.message ?? err }, 'sandbox stop failed'),
  );

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
  isDryRun: boolean;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, input, output, eventlog, isDryRun } = opts;
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
        isDryRun,
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
  /**
   * True when the run's lifecycle defines a Reviewer agent (#420, V2.al).
   * When set, the PR is opened as a draft regardless of test status; the
   * runner flips it to ready-for-review after the reviewer agent approves.
   */
  hasReviewerInLifecycle?: boolean;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, vcs, workspacePath, eventlog, logger, hasReviewerInLifecycle } = opts;

  const repo = await withTenant(organizationId, (tx) =>
    tx.connectedRepo.findUnique({ where: { projectId } }),
  );
  if (!repo) return;

  const limits = await loadBlastRadiusLimits(organizationId, projectId);
  const riskConfig = await loadRiskScoreConfig(organizationId, projectId);

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

  // For branch-per-env teams the integration branch differs from
  // GitHub's reported default; effectiveBaseBranch() coalesces #469.
  const baseBranch = effectiveBaseBranch(repo);
  const repoRef = {
    installationId: repo.installationId,
    repoId: repo.repoId ?? undefined,
    repoFullName: repo.repoFullName,
    defaultBranch: baseBranch,
  };

  for (const cs of changesets) {
    try {
      // Blast-radius gate (#285). Compare branch vs default-branch in
      // the local workspace before pushing; if any cap is exceeded,
      // mark the changeset blocked with the breakdown and skip push.
      const stats = await getLocalBranchStats(workspacePath, cs.branch, baseBranch);
      const verdict = checkBlastRadius({ files: stats }, limits);
      if (!verdict.ok) {
        await withTenant(organizationId, (tx) =>
          tx.changeset.update({
            where: { id: cs.id },
            data: {
              status: 'blocked',
              blockedReason: {
                kind: 'blast_radius',
                filesChanged: verdict.filesChanged,
                linesChanged: verdict.linesChanged,
                maxFilesChanged: verdict.maxFilesChanged,
                maxLinesChanged: verdict.maxLinesChanged,
                filesOverLimit: verdict.filesOverLimit,
                linesOverLimit: verdict.linesOverLimit,
                deniedHits: verdict.deniedHits,
              } as any,
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
          type: 'CHANGESET_FLAGGED',
          actor: { kind: 'system' },
          payload: {
            reason: 'blast_radius',
            filesChanged: verdict.filesChanged,
            linesChanged: verdict.linesChanged,
            deniedHits: verdict.deniedHits,
          },
        });
        logger.info(
          { changesetId: cs.id, filesChanged: verdict.filesChanged, linesChanged: verdict.linesChanged },
          'blast-radius: blocking changeset; skipping push',
        );
        continue;
      }

      await vcs.push(workspacePath, cs.branch);
      const body = buildPrBody(cs);
      const pr = await vcs.openPullRequest(repoRef, {
        head: cs.branch,
        base: baseBranch,
        title: cs.title,
        body,
        // Draft when tests failed (original behavior) OR when the
        // lifecycle has a Reviewer agent (#420, V2.al). In the latter
        // case, the runner flips the PR to ready-for-review after the
        // reviewer approves; a human sees an honest "agent reviewed,
        // approved" signal instead of a non-reviewed PR sitting open.
        draft: cs.status === 'tests_failed' || !!hasReviewerInLifecycle,
      });
      // #193: compute a risk chip from PR file stats + test summary so
      // reviewers see at a glance how much attention the change needs.
      // Best-effort — a fetch failure leaves the chip null and the UI
      // defaults to 'low'.
      let riskChip: RiskLevel | null = null;
      try {
        const files = await vcs.getPullRequestFiles(repoRef, pr.number);
        riskChip = computeRiskChip(files, cs.testSummary);
      } catch (riskErr: any) {
        logger.warn(
          { changesetId: cs.id, err: riskErr?.message ?? riskErr },
          'risk-chip: file fetch failed; leaving chip null',
        );
      }
      await withTenant(organizationId, (tx) =>
        tx.changeset.update({
          where: { id: cs.id },
          data: {
            prNumber: pr.number,
            prUrl: pr.url,
            riskChip,
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

      // Risk-score gate (#286). Reuses the same `stats` we computed for
      // blast-radius — no extra git work. A score over the threshold
      // suppresses auto-promote (regardless of rules) and lands an
      // ApprovalRequest on the inbox with the breakdown verbatim.
      const breakdown = computeRiskScore({ files: stats }, riskConfig.sensitivePaths);
      await withTenant(organizationId, (tx) =>
        tx.changeset.update({
          where: { id: cs.id },
          data: {
            riskScore: breakdown.score,
            riskScoreBreakdown: {
              filesChanged: breakdown.filesChanged,
              linesChanged: breakdown.linesChanged,
              sensitiveHits: breakdown.sensitiveHits,
            } as any,
          },
        }),
      );
      const needsApproval = breakdown.score > riskConfig.autoMergeThreshold;
      if (needsApproval) {
        await withTenant(organizationId, (tx) =>
          tx.approvalRequest.create({
            data: {
              organizationId,
              projectId,
              workflowRunId,
              changesetId: cs.id,
              reason: 'risk_score_high',
              details: {
                score: breakdown.score,
                threshold: riskConfig.autoMergeThreshold,
                filesChanged: breakdown.filesChanged,
                linesChanged: breakdown.linesChanged,
                sensitiveHits: breakdown.sensitiveHits,
                prNumber: pr.number,
                prUrl: pr.url,
              } as any,
              requiredRole: 'operator',
            },
          }),
        );
        await eventlog.emit({
          organizationId,
          projectId,
          dailyRunId: runId,
          workflowRunId,
          changesetId: cs.id,
          type: 'GATE_REACHED',
          actor: { kind: 'system' },
          payload: {
            reason: 'risk_score_high',
            score: breakdown.score,
            threshold: riskConfig.autoMergeThreshold,
          },
        });
        logger.info(
          { changesetId: cs.id, score: breakdown.score, threshold: riskConfig.autoMergeThreshold },
          'risk-score: above threshold; suppressing auto-promote, surfaced to inbox',
        );
      }

      // Auto-promote check (#154): if the project has rules and the diff
      // matches one, flip the changeset straight to 'promoted' without
      // sitting in the manual approval gate. Errors here are non-fatal —
      // a failure leaves the changeset as 'pr_open' for the human gate.
      // Skipped when the risk-score gate has surfaced this changeset.
      if (needsApproval) continue;
      try {
        await applyAutoPromoteIfMatches({
          organizationId,
          projectId,
          runId,
          workflowRunId,
          changesetId: cs.id,
          prNumber: pr.number,
          repoRef,
          vcs,
          eventlog,
          logger,
        });
      } catch (e: any) {
        logger.warn(
          { changesetId: cs.id, err: e?.message ?? e },
          'auto-promote: evaluation failed; leaving changeset on the manual gate',
        );
      }
    } catch (e: any) {
      logger.warn(
        { changesetId: cs.id, err: e?.message ?? e },
        'auto-open-pr: failed; leaving changeset as-is',
      );
    }
  }
}

async function applyAutoPromoteIfMatches(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  changesetId: string;
  prNumber: number;
  repoRef: { installationId: string; repoId?: string; repoFullName: string; defaultBranch: string };
  vcs: VcsProvider;
  eventlog: Eventlog;
  logger: Logger;
}): Promise<void> {
  const project = await withTenant(opts.organizationId, (tx) =>
    tx.project.findUnique({ where: { id: opts.projectId } }),
  );
  const rawRules = ((project as any)?.autoPromoteRules ?? []) as unknown[];
  if (rawRules.length === 0) return;

  // Validate cached rules; tolerate (skip) any that lost shape compatibility
  // with the current schema. The UI rejects malformed rules on write, so a
  // bad row here is a migration artifact — log and move on.
  const rules: AutoPromoteRuleType[] = [];
  for (const raw of rawRules) {
    const r = AutoPromoteRule.safeParse(raw);
    if (r.success) rules.push(r.data);
    else opts.logger.warn({ projectId: opts.projectId, raw }, 'auto-promote: skipping invalid rule');
  }
  if (rules.length === 0) return;

  const files = await opts.vcs.getPullRequestFiles(opts.repoRef, opts.prNumber);
  const candidate = {
    files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
  };

  // Parse package.json version diffs lazily — only when at least one rule
  // requires them and at least one package.json is in the diff. We accept
  // the parse result only if EVERY changed package.json yields a clean
  // parse; any single failure leaves `packageJsonChanges` undefined and
  // the matcher's safety rule (#154) rejects requirePackageJsonPatchOnly.
  const needsPkgDiff = rules.some((r) => r.requirePackageJsonPatchOnly);
  const packageFiles = files.filter((f) => /(^|\/)package\.json$/.test(f.path));
  let packageJsonChanges: PackageJsonVersionChange[] | undefined;
  if (needsPkgDiff && packageFiles.length > 0) {
    try {
      const accumulated: PackageJsonVersionChange[] = [];
      let parseFailed = false;
      for (const f of packageFiles) {
        const [before, after] = await Promise.all([
          opts.vcs.getFileAt(opts.repoRef, opts.repoRef.defaultBranch, f.path),
          opts.vcs.getFileAt(opts.repoRef, `refs/pull/${opts.prNumber}/head`, f.path),
        ]);
        const parsed = parsePackageJsonDiff(
          Buffer.from(before.contentBase64, 'base64').toString('utf8'),
          Buffer.from(after.contentBase64, 'base64').toString('utf8'),
        );
        if (parsed === null) {
          parseFailed = true;
          break;
        }
        accumulated.push(...parsed);
      }
      if (!parseFailed) packageJsonChanges = accumulated;
    } catch (err: any) {
      opts.logger.warn(
        { changesetId: opts.changesetId, err: err?.message ?? err },
        'auto-promote: package.json fetch/parse failed; falling back to safe reject',
      );
    }
  }
  const fullCandidate = packageJsonChanges !== undefined
    ? { ...candidate, packageJsonChanges }
    : candidate;

  for (const rule of rules) {
    const result = autoPromoteMatches(rule, fullCandidate);
    if (!result.matched) continue;

    await withTenant(opts.organizationId, (tx) =>
      tx.changeset.update({
        where: { id: opts.changesetId },
        data: { status: 'promoted', updatedAt: new Date() },
      }),
    );
    await opts.eventlog.emit({
      organizationId: opts.organizationId,
      projectId: opts.projectId,
      dailyRunId: opts.runId,
      workflowRunId: opts.workflowRunId,
      changesetId: opts.changesetId,
      type: 'CHANGESET_AUTO_PROMOTED',
      actor: { kind: 'system' },
      payload: { ruleName: rule.name, prNumber: opts.prNumber },
    });
    opts.logger.info(
      { changesetId: opts.changesetId, rule: rule.name },
      'auto-promote: matched, changeset promoted',
    );
    return;
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

/**
 * Read the project's blast-radius limits (#285). Falls back to safe
 * defaults if the row is missing the columns somehow (back-compat for
 * environments lagging on migrations).
 */
async function loadBlastRadiusLimits(
  organizationId: string,
  projectId: string,
): Promise<BlastRadiusLimits> {
  const row = await withTenant(organizationId, (tx) =>
    tx.project.findUnique({
      where: { id: projectId },
      select: { maxFilesChanged: true, maxLinesChanged: true, deniedPaths: true },
    }),
  );
  return {
    maxFilesChanged: row?.maxFilesChanged ?? 25,
    maxLinesChanged: row?.maxLinesChanged ?? 1000,
    deniedPaths: Array.isArray(row?.deniedPaths)
      ? (row.deniedPaths as string[])
      : ['**/migration*', '**/secrets*', '**/.env*', '**/*.pem', '**/*.key'],
  };
}

/**
 * Read the project's risk-score config (#286). Same back-compat posture
 * as loadBlastRadiusLimits — defaults match the migration's defaults so
 * old rows behave the same as new ones once they're filled in.
 */
async function loadRiskScoreConfig(
  organizationId: string,
  projectId: string,
): Promise<{ autoMergeThreshold: number; sensitivePaths: string[] }> {
  const row = await withTenant(organizationId, (tx) =>
    tx.project.findUnique({
      where: { id: projectId },
      select: { autoMergeThreshold: true, sensitivePaths: true },
    }),
  );
  return {
    autoMergeThreshold: row?.autoMergeThreshold ?? 50,
    sensitivePaths: Array.isArray(row?.sensitivePaths)
      ? (row.sensitivePaths as string[])
      : ['**/config/**', '**/auth/**', '**/*.sql'],
  };
}

/**
 * `git diff --numstat origin/<defaultBranch>...<branch>` in the runner's
 * workspace. Returns per-file additions + deletions for blast-radius
 * accounting. Empty array when the branch hasn't diverged.
 */
async function getLocalBranchStats(
  workspacePath: string,
  branch: string,
  defaultBranch: string,
): Promise<{ path: string; additions: number; deletions: number }[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--numstat', `origin/${defaultBranch}...${branch}`],
      { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [add, del, ...pathParts] = line.split(/\s+/);
        // Binary files render as "-\t-\t<path>" in numstat; count those
        // as 0 additions/deletions so they only trip the file-count cap.
        const additions = add === '-' ? 0 : Number(add) || 0;
        const deletions = del === '-' ? 0 : Number(del) || 0;
        return { path: pathParts.join(' '), additions, deletions };
      })
      .filter((f) => f.path);
  } catch {
    // Best-effort: a git failure (e.g. missing default branch ref)
    // should NOT block the push — the human-gate downstream is still
    // there. Returning [] makes the blast-radius check pass through.
    return [];
  }
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

/**
 * Monthly cap check (#282). Mirrors checkDailyBudget but anchored to
 * the 1st of the current calendar month (UTC). NULL cap = unlimited.
 * Calendar-month boundary is independent of org timezone — billing
 * periods on the LLM-provider side are calendar UTC, so this matches
 * what the operator sees on their Anthropic/OpenAI invoice.
 */
async function checkMonthlyCap(
  organizationId: string,
): Promise<{ exceeded: boolean; spent: number; cap: number | null }> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findUnique({ where: { id: organizationId } }),
  );
  const cap =
    org?.monthlySpendCapUsd === null || org?.monthlySpendCapUsd === undefined
      ? null
      : Number(org.monthlySpendCapUsd);
  if (cap === null) return { exceeded: false, spent: 0, cap: null };
  const agg = await withTenant(organizationId, (tx) =>
    tx.llmInvocation.aggregate({
      where: { organizationId, occurredAt: { gte: since } },
      _sum: { usdEstimate: true },
    }),
  );
  const spent = Number(agg._sum.usdEstimate ?? 0);
  return { exceeded: spent >= cap, spent, cap };
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
  agentDef: { kind: string },
  _cfg: MergecrewConfig,
): Promise<unknown> {
  // Discovery mode for the planner (#492). When a project has no
  // queued intent AND no prior changesets, there is no concrete task
  // to plan against — the default planner prompt would degenerate to
  // "please give me instructions." Instead we set a `mode: 'discovery'`
  // flag and the runner (caller below) swaps in
  // PLANNER_DISCOVERY_SYSTEM_PROMPT so the planner explores the repo
  // and proposes three candidate first runs. The orchestrator routes
  // on `output.mode === 'discovery'` to terminate the chain.
  if (agentDef.kind === PLANNER_AGENT_KIND) {
    const [queuedIntents, priorChangesets] = await Promise.all([
      withTenant(organizationId, (tx) =>
        tx.intentInboxItem.count({ where: { projectId, status: 'queued' } }),
      ),
      withTenant(organizationId, (tx) => tx.changeset.count({ where: { projectId } })),
    ]);
    if (queuedIntents === 0 && priorChangesets === 0) {
      return {
        runId,
        agentRef,
        mode: 'discovery',
        instruction:
          'No task has been queued yet for this project. Explore the repo and propose three candidate first runs.',
      };
    }
  }

  // Reviewer agents (#334) consume the planner's plan AND the coder's
  // changeset to produce a structured verdict. If the runner already
  // detected an out-of-scope edit (#333 emit), include that signal in
  // the input so the LLM doesn't have to re-derive it — the prompt is
  // primed toward request_changes when it's there.
  if (agentDef.kind === REVIEWER_AGENT_KIND) {
    const planStep = await withTenant(organizationId, (tx) =>
      tx.agentStep.findFirst({
        where: {
          workflowRun: { dailyRunId: runId },
          agentKind: PLANNER_AGENT_KIND,
          status: 'completed',
          output: { not: undefined },
        },
        orderBy: { finishedAt: 'desc' },
        select: { output: true },
      }),
    );
    const planMarkdown =
      (planStep?.output as { planMarkdown?: string } | null)?.planMarkdown ?? null;

    // Most recent changeset produced in this run. The reviewer fetches
    // the actual diff via its read-only repo skills (the changeset row
    // doesn't store the diff text — it lives in git). We hand over
    // the changeset id, title, and the file paths from the risk-score
    // breakdown so the reviewer has structured context to start from.
    const cs = await withTenant(organizationId, (tx) =>
      tx.changeset.findFirst({
        where: { projectId, dailyRunId: runId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, branch: true, riskScoreBreakdown: true },
      }),
    );

    // Hint signal from #333. The reviewer can fast-path to
    // request_changes when this is non-empty.
    const outOfScopeEvents = await withTenant(organizationId, (tx) =>
      tx.timelineEvent.findMany({
        where: {
          projectId,
          dailyRunId: runId,
          type: 'AGENT_DECISION',
        },
        orderBy: { occurredAt: 'desc' },
        take: 5,
        select: { payload: true },
      }),
    );
    const outOfScopeHits = outOfScopeEvents
      .map((e) => e.payload as { kind?: string; offending?: unknown } | null)
      .filter((p): p is { kind: string; offending: unknown } => p?.kind === 'out_of_scope_edit');

    return {
      runId,
      agentRef,
      instruction: `You are the Reviewer agent. Decide whether the diff is ready for PR open.`,
      planMarkdown,
      changeset: cs
        ? {
            id: cs.id,
            title: cs.title,
            branch: cs.branch,
            filesChanged:
              (cs.riskScoreBreakdown as { paths?: string[] } | null)?.paths ?? [],
          }
        : null,
      outOfScopeHints: outOfScopeHits.map((h) => h.offending),
    };
  }

  // Coder agents (#333) consume the planner's markdown plan from the
  // most recent planner step in this run. We use the persisted
  // agent_steps.output rather than scanning timeline events — the
  // output is the canonical store; the event is just a notification.
  if (agentDef.kind === CODER_AGENT_KIND) {
    const planStep = await withTenant(organizationId, (tx) =>
      tx.agentStep.findFirst({
        where: {
          workflowRun: { dailyRunId: runId },
          agentKind: PLANNER_AGENT_KIND,
          status: 'completed',
          output: { not: undefined },
        },
        orderBy: { finishedAt: 'desc' },
        select: { output: true },
      }),
    );
    const planMarkdown =
      (planStep?.output as { planMarkdown?: string } | null)?.planMarkdown ?? null;
    // Loop-back path (#349): if the latest reviewer step in this run
    // requested changes, surface its reasoning + requestedChanges so
    // the coder addresses them directly instead of re-running blind.
    // First coder pass returns null here (no prior reviewer step).
    const reviewerStep = await withTenant(organizationId, (tx) =>
      tx.agentStep.findFirst({
        where: {
          workflowRun: { dailyRunId: runId },
          agentKind: REVIEWER_AGENT_KIND,
          status: 'completed',
          output: { not: undefined },
        },
        orderBy: { finishedAt: 'desc' },
        select: { output: true },
      }),
    );
    const reviewerOutput = reviewerStep?.output as
      | { verdict?: string; reasoning?: string; requestedChanges?: string[] }
      | null;
    const carefulReviewerFeedback =
      reviewerOutput && reviewerOutput.verdict === 'request_changes'
        ? {
            reasoning: reviewerOutput.reasoning ?? '',
            requestedChanges: reviewerOutput.requestedChanges ?? [],
          }
        : null;
    return {
      runId,
      agentRef,
      instruction: `You are the ${agentRef} coder. Implement the plan below using your tools.`,
      planMarkdown,
      ...(carefulReviewerFeedback ? { carefulReviewerFeedback } : {}),
    };
  }

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

  // BackendEngineer (#518) / FrontendEngineer (#519), V2.af roster.
  // Both consume the most recent PM spec in this run and implement
  // their half of it. PM tags the spec `target: backend | frontend |
  // both`; the engineer whose target doesn't match short-circuits
  // with `skip: true` so the agent emits a one-line `SKIPPED:` and
  // exits without making changes — fan-in still resolves cleanly
  // because the step `completes`. The agents run without a spec only
  // on a misconfigured graph (no PM stage upstream); we surface that
  // as a skip too rather than letting the LLM invent work.
  if (
    agentDef.kind === BACKEND_ENGINEER_AGENT_KIND ||
    agentDef.kind === FRONTEND_ENGINEER_AGENT_KIND
  ) {
    const isBackend = agentDef.kind === BACKEND_ENGINEER_AGENT_KIND;
    const myTarget: PmSpecTarget = isBackend ? 'backend' : 'frontend';
    const otherTarget: PmSpecTarget = isBackend ? 'frontend' : 'backend';
    const role = isBackend ? 'Backend Engineer' : 'Frontend Engineer';
    const portion = isBackend ? 'server-side' : 'UI';
    const sibling = isBackend ? 'Frontend Engineer' : 'Backend Engineer';
    const siblingScope = isBackend ? 'UI changes' : 'server code';

    const spec = await loadPmSpecForRun(organizationId, runId);
    if (!spec) {
      return {
        runId,
        agentRef,
        instruction:
          'No PM spec is available for this run. Emit a single line `SKIPPED: no_pm_spec` and stop.',
        skip: true,
        skipReason: 'no_pm_spec',
      };
    }
    if (spec.target === otherTarget) {
      return {
        runId,
        agentRef,
        instruction: `PM tagged this spec \`target: ${otherTarget}\` — there is no ${myTarget} work in scope. Emit a single line \`SKIPPED: target_mismatch\` and stop.`,
        skip: true,
        skipReason: 'target_mismatch',
        spec,
      };
    }
    return {
      runId,
      agentRef,
      instruction: `You are the ${role}. Implement the ${portion} portion of the supplied spec. The ${sibling} is running in parallel — leave ${siblingScope} to them.`,
      spec,
    };
  }

  // DocWriter agent input (#525, V2.af roster). Final roster agent
  // — runs in the parallel observation stage alongside Observation /
  // DesignReviewer / BugTriage. Input bundles the run's most-recent
  // changeset (id, branch, title, PR number) so the agent can write
  // a docs-follow-up commit with a subject like `docs: follow-up to
  // PR #<n>`.
  if (agentDef.kind === DOC_WRITER_AGENT_KIND) {
    const cs = await withTenant(organizationId, (tx) =>
      tx.changeset.findFirst({
        where: { projectId, dailyRunId: runId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          branch: true,
          whyParagraph: true,
          prNumber: true,
          prUrl: true,
        },
      }),
    );
    return {
      runId,
      agentRef,
      instruction:
        'You are the Doc Writer. Decide whether the supplied changeset warrants a docs update. Only edit README.md / docs/** / CHANGELOG.md — never source files. Commit on a sibling branch with a subject like `docs: follow-up to PR #<n>`. Emit the structured VERDICT block prescribed by your system prompt; choose `no_op` when no user-facing change in the run warrants a doc update.',
      changeset: cs,
    };
  }

  // Observation agent input (#523, V2.af roster). Runs in the
  // parallel observation stage alongside DesignReviewer / BugTriage
  // / DocWriter. Distinct from DesignReviewer: Observation does an
  // HTTP-level smoke check (does the page respond, 2xx, expected
  // keywords) — DesignReviewer does the visual-level check. Pulls
  // the dev URL from the SRE step's `output.deployment.url` so the
  // agent doesn't have to re-resolve.
  if (agentDef.kind === OBSERVATION_AGENT_KIND) {
    const sreStep = await withTenant(organizationId, (tx) =>
      tx.agentStep.findFirst({
        where: {
          workflowRun: { dailyRunId: runId },
          agentKind: SRE_AGENT_KIND,
          status: 'completed',
          output: { not: undefined },
        },
        orderBy: { finishedAt: 'desc' },
        select: { output: true },
      }),
    );
    const devUrl =
      (sreStep?.output as { deployment?: { url?: string | null } } | null)
        ?.deployment?.url ?? null;
    return {
      runId,
      agentRef,
      instruction:
        'You are the Observation agent. Run web.smoke_check against the supplied dev URL, assert HTTP 2xx, and emit the structured VERDICT block prescribed by your system prompt. When the dev URL is null, emit the no-deploy fallback verdict. If the smoke check fails, file a synthetic intent describing the failure before terminating.',
      devUrl,
    };
  }

  // DesignReviewer agent input (#522, V2.af roster). Runs in the
  // parallel observation stage after SRE. Pulls the dev URL from the
  // most-recent SRE step's `output.deployment.url` so the agent
  // doesn't have to re-resolve via `deploy.url_for_branch` for the
  // happy path. Falls back to null so the agent's no-vision /
  // no-deploy branch (system prompt prescribes a fallback verdict)
  // still parses cleanly.
  if (agentDef.kind === DESIGN_REVIEWER_AGENT_KIND) {
    const sreStep = await withTenant(organizationId, (tx) =>
      tx.agentStep.findFirst({
        where: {
          workflowRun: { dailyRunId: runId },
          agentKind: SRE_AGENT_KIND,
          status: 'completed',
          output: { not: undefined },
        },
        orderBy: { finishedAt: 'desc' },
        select: { output: true },
      }),
    );
    const devUrl =
      (sreStep?.output as { deployment?: { url?: string | null } } | null)
        ?.deployment?.url ?? null;
    const cs = await withTenant(organizationId, (tx) =>
      tx.changeset.findFirst({
        where: { projectId, dailyRunId: runId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, branch: true, title: true },
      }),
    );
    return {
      runId,
      agentRef,
      instruction:
        'You are the Design Reviewer agent. Capture a screenshot of the supplied dev URL via web.screenshot_url, pass it to design.review_screenshot for visual diff, and emit the structured VERDICT block prescribed by your system prompt. When the dev URL is null or no vision-capable model is configured, emit the no-vision fallback verdict.',
      devUrl,
      changeset: cs,
    };
  }

  // SRE agent input (#521, V2.af roster). SRE moves the QA-passed
  // changeset to the dev environment via the existing DeployProvider
  // adapter (the dev-deploy code lives in `triggerPendingDevDeploys`
  // below — kept as the implementation the SRE post-process calls).
  // Input bundles the in-flight changeset (id, PR number, branch) +
  // the project's configured dev deploy target so the agent can
  // reference adapter/URL without re-querying.
  if (agentDef.kind === SRE_AGENT_KIND) {
    const cs = await withTenant(organizationId, (tx) =>
      tx.changeset.findFirst({
        where: {
          projectId,
          dailyRunId: runId,
          prNumber: { not: null },
          status: { in: ['pr_open', 'testing', 'dev_deployed'] },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, branch: true, prNumber: true, prUrl: true, status: true },
      }),
    );
    const dt = await withTenant(organizationId, (tx) =>
      tx.deployTarget.findFirst({
        where: { projectId, kind: 'dev' },
        select: { id: true, adapterId: true, kind: true },
      }),
    );
    return {
      runId,
      agentRef,
      instruction:
        'You are the SRE agent. Trigger the dev deploy for the supplied changeset via `deploy.dev`, poll `deploy.status` until terminal, then post the dev URL as a PR comment via `repo.git.comment_pr`. On failure, capture `deploy.logs` (last 200 lines) and comment them on the PR so a human can debug. Do not promote to production.',
      changeset: cs,
      deployTarget: dt,
    };
  }

  // QA agent input (#520, V2.af roster). QA reads the in-flight
  // changeset the engineers produced — branch name, the file paths
  // recorded on the risk-score breakdown — and the PM spec the
  // changeset was built against so the agent can compare delivered
  // work against acceptance criteria. The actual test execution
  // happens through the build/test skills (read-only as far as the
  // repo is concerned); this branch just stages the context.
  if (agentDef.kind === QA_AGENT_KIND) {
    const spec = await loadPmSpecForRun(organizationId, runId);
    const cs = await withTenant(organizationId, (tx) =>
      tx.changeset.findFirst({
        where: {
          projectId,
          dailyRunId: runId,
          status: { in: ['proposed', 'building', 'testing', 'tests_failed', 'pr_open'] },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, branch: true, riskScoreBreakdown: true },
      }),
    );
    return {
      runId,
      agentRef,
      instruction:
        'You are the QA agent. Verify the engineers\' changeset by running install, typecheck, lint, unit tests, and integration tests in order. Emit the structured VERDICT block prescribed by your system prompt. Do not edit files.',
      changeset: cs
        ? {
            id: cs.id,
            title: cs.title,
            branch: cs.branch,
            filesChanged:
              (cs.riskScoreBreakdown as { paths?: string[] } | null)?.paths ?? [],
          }
        : null,
      spec,
    };
  }

  // PM agent input (#517, V2.af roster). Consumes the oldest queued
  // intent and scopes it into a spec the engineer agents read. Mirrors
  // the planner-seed-goal path (#493) below — the two are mutually
  // exclusive in practice because a project runs ONE graph profile at
  // a time. The intent is flipped `queued → picked_up` atomically so a
  // parallel/retry run doesn't re-consume it.
  if (agentDef.kind === PM_AGENT_KIND) {
    const intent = await withTenant(organizationId, (tx) =>
      tx.intentInboxItem.findFirst({
        where: { projectId, status: 'queued' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (intent) {
      await withTenant(organizationId, (tx) =>
        tx.intentInboxItem.update({
          where: { id: intent.id },
          data: { status: 'picked_up', pickedUpRunId: runId },
        }),
      );
      return {
        runId,
        agentRef,
        instruction:
          'You are the PM agent. Scope the supplied intent into a single structured spec the engineers can implement in one run. Use the format the PM_SYSTEM_PROMPT prescribes; respond with SPEC_GAP if the intent is too vague or too large.',
        intent: {
          id: intent.id,
          body: intent.body,
          submittedByUserId: intent.submittedByUserId,
          sourceKey: intent.sourceKey,
        },
      };
    }
    // No queued intent. The roster graph's discovery edge should have
    // routed to __end__ before reaching here, but if it didn't (custom
    // graph, hand-edited dispatch), return a stub input — the PM agent
    // will emit `SPEC_GAP` since there's nothing to scope.
    return {
      runId,
      agentRef,
      instruction:
        'No queued intent. Respond with SPEC_GAP: explain that there is nothing to scope yet.',
    };
  }

  // Planner seed goal (#493). When the onboarding wizard captured a
  // first-task description, it persists as a queued IntentInboxItem.
  // The planner consumes the oldest queued intent on its next run and
  // plans against the goal text instead of asking the LLM "what would
  // you like me to do?". The intent is flipped to `picked_up` with
  // `pickedUpRunId = runId` atomically so a parallel/retry run doesn't
  // re-consume the same goal. Other agentRefs (discovery, pm,
  // engineers) keep their own paths.
  if (agentDef.kind === PLANNER_AGENT_KIND) {
    const intent = await withTenant(organizationId, (tx) =>
      tx.intentInboxItem.findFirst({
        where: { projectId, status: 'queued' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (intent) {
      await withTenant(organizationId, (tx) =>
        tx.intentInboxItem.update({
          where: { id: intent.id },
          data: { status: 'picked_up', pickedUpRunId: runId },
        }),
      );
      return {
        runId,
        agentRef,
        instruction:
          'A seed goal was captured during onboarding. Plan against it — produce a structured "Files to touch" plan exactly as the default planner prompt asks.',
        seedGoal: intent.body,
        seedGoalIntentId: intent.id,
      };
    }
  }

  // Implementing agents on a tests_failed loop or PR review pass should see
  // the open reviewer comments so they can address them directly. Looks at
  // the most-recently-updated active changeset in this run; resolved
  // comments are filtered out so the list shrinks as work progresses.
  const reviewerFeedback = await loadReviewerFeedback(organizationId, projectId, runId, agentRef);
  return {
    runId,
    instruction: `You are the ${agentRef} agent. Plan and execute your scoped task.`,
    ...(reviewerFeedback ? { reviewerFeedback } : {}),
  };
}

/**
 * Load the most recent PM spec persisted in this daily run (#518).
 *
 * The PM agent post-process writes `{ spec, markdown, sourceIntentId }`
 * onto `agent_steps.output` (see PM_AGENT_KIND post-process above).
 * Engineer agents call this helper to retrieve the structured spec —
 * the markdown is kept on the row for UI display but we return only
 * the parsed shape so consumers don't re-parse it.
 *
 * Returns `null` when no completed PM step exists in the run, or when
 * the most recent one parsed to `null` (SPEC_GAP). The caller is
 * expected to treat both cases the same: no engineering work to do.
 */
async function loadPmSpecForRun(
  organizationId: string,
  runId: string,
): Promise<ParsedPmSpec | null> {
  const pmStep = await withTenant(organizationId, (tx) =>
    tx.agentStep.findFirst({
      where: {
        workflowRun: { dailyRunId: runId },
        agentKind: PM_AGENT_KIND,
        status: 'completed',
        output: { not: undefined },
      },
      orderBy: { finishedAt: 'desc' },
      select: { output: true },
    }),
  );
  const persisted = pmStep?.output as
    | { spec?: ParsedPmSpec | null; markdown?: string }
    | null
    | undefined;
  if (!persisted) return null;
  // Prefer the parsed shape — but if the PM step ran before #518
  // shipped, the persisted spec lacks `target`. Re-parse the markdown
  // in that case so callers always get the new field. Re-parse also
  // covers the SPEC_GAP path (spec === null but markdown present).
  if (persisted.spec && (persisted.spec as ParsedPmSpec).target) {
    return persisted.spec;
  }
  if (persisted.markdown) {
    return parsePmSpec(persisted.markdown);
  }
  return null;
}

async function loadReviewerFeedback(
  organizationId: string,
  projectId: string,
  runId: string,
  agentRef: string,
): Promise<{
  changesetId: string;
  instruction: string;
  comments: Array<{
    id: string;
    parentId: string | null;
    filePath: string;
    lineRange: { startLine: number; endLine: number } | null;
    body: string;
    author: string;
    createdAt: string;
  }>;
} | null> {
  // Only the engineer / qa loop benefits from inline reviewer feedback —
  // discovery and PM run before any changeset exists, sre's brief is the
  // deploy not the diff, and downstream observation agents work post-merge.
  const consumers = new Set([
    'backend_engineer',
    'frontend_engineer',
    'qa',
  ]);
  if (!consumers.has(agentRef)) return null;

  const cs = await withTenant(organizationId, (tx) =>
    tx.changeset.findFirst({
      where: {
        projectId,
        dailyRunId: runId,
        status: { in: ['proposed', 'building', 'testing', 'tests_failed', 'pr_open'] },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    }),
  );
  if (!cs) return null;

  const rows = await withTenant(organizationId, (tx) =>
    tx.changesetComment.findMany({
      where: { changesetId: cs.id, resolvedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true, name: true } } },
    }),
  );
  if (rows.length === 0) return null;

  return {
    changesetId: cs.id,
    instruction:
      'Reviewer comments below are open on the current changeset. Address each one and call `changeset.resolve_comment` with its id once handled. If a comment is out of scope, leave it open and explain why in your output.',
    comments: rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      filePath: r.filePath,
      lineRange: (r.lineRange as { startLine: number; endLine: number } | null) ?? null,
      body: r.body,
      author: r.user.name ?? r.user.email,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * After a Coder step (#333), check whether any of its changesets
 * touched files outside the planner's "Files to touch" list. Emits an
 * AGENT_DECISION event when out-of-scope edits exist so the reviewer
 * agent (#334) can route the changeset back for revision. Silently
 * skips when no plan is available (legacy / non-multi-agent runs).
 */
async function emitOutOfScopeIfAny(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  agentKind: string;
  eventlog: Eventlog;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, stepId, agentKind, eventlog } = opts;
  // Find the latest plan in this run. Same query shape as
  // synthesizeAgentInput for the coder.
  const planStep = await withTenant(organizationId, (tx) =>
    tx.agentStep.findFirst({
      where: {
        workflowRun: { dailyRunId: runId },
        agentKind: PLANNER_AGENT_KIND,
        status: 'completed',
        output: { not: undefined },
      },
      orderBy: { finishedAt: 'desc' },
      select: { output: true },
    }),
  );
  const planMarkdown =
    (planStep?.output as { planMarkdown?: string } | null)?.planMarkdown ?? null;
  if (!planMarkdown) return;

  const parsed = parsePlanPaths(planMarkdown);
  if (!parsed) return;

  // Look up changesets created in this run; compare their `filesChanged`
  // against the allowed set. We trust the existing riskScoreBreakdown
  // path-list rather than re-reading the diff.
  const changesets = await withTenant(organizationId, (tx) =>
    tx.changeset.findMany({
      where: { projectId, dailyRunId: runId },
      select: { id: true, riskScoreBreakdown: true },
    }),
  );
  const outOfScope: Array<{ changesetId: string; paths: string[] }> = [];
  for (const cs of changesets) {
    const paths =
      (cs.riskScoreBreakdown as { paths?: string[] } | null)?.paths ?? [];
    const touchedOutside = paths.filter((p) => !parsed.filesToTouch.includes(p));
    if (touchedOutside.length > 0) {
      outOfScope.push({ changesetId: cs.id, paths: touchedOutside });
    }
  }
  if (outOfScope.length === 0) return;

  await eventlog.emit({
    organizationId,
    projectId,
    dailyRunId: runId,
    workflowRunId,
    agentStepId: stepId,
    type: 'AGENT_DECISION',
    actor: { kind: 'agent', id: stepId, agentKind },
    payload: { kind: 'out_of_scope_edit', allowedFiles: parsed.filesToTouch, offending: outOfScope },
  });
}

/**
 * Demo-mode placeholder changeset (#373). The stub coder never calls
 * `repo.git.commit`, so no Changeset row is created via the normal
 * skill path. We synthesize a minimal Changeset here so the careful
 * chain produces a visible artifact for the run-detail page +
 * Changesets list, and so the Reviewer step that follows has
 * something to reason about (its verdict is canned anyway under
 * stub mode).
 *
 * Pulls the why-paragraph from the most recent planner step's output
 * for verisimilitude — the seeded sample run (#362) does the same
 * thing statically.
 *
 * Idempotent within a run: skips silently when a Changeset already
 * exists for this workflowRunId. That happens on coder loop-back
 * rounds — the first round created the placeholder, retries don't
 * need to duplicate it.
 */
async function synthesizeStubChangeset(opts: {
  organizationId: string;
  projectId: string;
  runId: string;
  workflowRunId: string;
  stepId: string;
  eventlog: Eventlog;
}): Promise<void> {
  const { organizationId, projectId, runId, workflowRunId, stepId, eventlog } = opts;
  const existing = await withTenant(organizationId, (tx) =>
    tx.changeset.findFirst({ where: { workflowRunId }, select: { id: true } }),
  );
  if (existing) return;

  const planStep = await withTenant(organizationId, (tx) =>
    tx.agentStep.findFirst({
      where: {
        workflowRun: { dailyRunId: runId },
        agentKind: PLANNER_AGENT_KIND,
        status: 'completed',
      },
      orderBy: { finishedAt: 'desc' },
      select: { output: true },
    }),
  );
  const planSnippet = ((planStep?.output as { planMarkdown?: string } | null)?.planMarkdown ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 4)
    .join('\n');

  const changesetId = `cs-demo-stub-${stepId.slice(0, 8)}`;
  const branch = `stub/demo-${stepId.slice(0, 8)}`;
  await withTenant(organizationId, (tx) =>
    tx.changeset.create({
      data: {
        id: changesetId,
        organizationId,
        projectId,
        dailyRunId: runId,
        workflowRunId,
        title: 'Stub: sample multi-agent change (demo mode)',
        whyParagraph:
          planSnippet ||
          'Synthesized placeholder for demo-mode runs. The stub coder does not edit files; this row exists so the careful chain produces a visible artifact.',
        branch,
        status: 'proposed',
        riskChip: 'low',
        estimatedUsd: 0,
      },
    }),
  );
  await eventlog.emit({
    organizationId,
    projectId,
    dailyRunId: runId,
    workflowRunId,
    agentStepId: stepId,
    changesetId,
    type: 'CHANGESET_OPENED',
    actor: { kind: 'agent', id: stepId, agentKind: CODER_AGENT_KIND },
    payload: { changesetId, title: 'Stub: sample multi-agent change (demo mode)', stub: true },
  });
}

/**
 * Compute the step's effective budget spec for #351 per-kind run
 * budgets. Loads the kind's prior model-turn spend from this workflow
 * run and delegates the clamp math to `clampBudgetForRun` so the
 * arithmetic can be unit-tested in domain without a DB.
 */
async function computeEffectiveBudget(opts: {
  organizationId: string;
  workflowRunId: string;
  agentKind: string;
  perStep?: { tokens?: number; usd?: number };
  runBudget?: { tokens?: number; usd?: number };
}): Promise<{ tokens?: number; usd?: number } | undefined> {
  const { organizationId, workflowRunId, agentKind, perStep, runBudget } = opts;
  if (!runBudget) return perStep;

  const priorTurns = await withTenant(organizationId, (tx) =>
    tx.modelTurn.findMany({
      where: { step: { workflowRunId, agentKind } },
      select: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        thinkingTokens: true,
        usdEstimate: true,
      },
    }),
  );
  const priorTokens = priorTurns.reduce(
    (sum, t) =>
      sum +
      t.inputTokens +
      t.outputTokens +
      (t.cacheReadTokens ?? 0) +
      (t.cacheWriteTokens ?? 0) +
      (t.thinkingTokens ?? 0),
    0,
  );
  const priorUsd = priorTurns.reduce((sum, t) => sum + Number(t.usdEstimate), 0);

  return clampBudgetForRun({
    perStep,
    runBudget,
    prior: { tokens: priorTokens, usd: priorUsd },
  });
}
