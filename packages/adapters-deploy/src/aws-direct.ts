import type {
  DeployHandle,
  DeployOpts,
  DeployProvider,
  DeployResult,
  DeployStatus,
  DeployTargetRef,
  LogChunk,
} from './types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

interface AwsDirectConfig {
  /**
   * Default region for SDK clients. Per-target config can override this so
   * one runner can deploy to multiple regions simultaneously.
   */
  region?: string;
  /**
   * Static credentials for environments where the default credential chain
   * isn't available (e.g., Docker without IMDS). When omitted the SDK falls
   * back to env vars / shared config / instance profile / SSO etc.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/**
 * Discriminated union over the three sub-modes. Operators pick one per
 * deploy target so a single `aws-direct` adapter id covers the common
 * AWS deploy shapes without forcing them to choose between Lambda and
 * ECS at the package boundary.
 */
export type AwsDirectTargetConfig =
  | AwsDirectLambdaTarget
  | AwsDirectEcsTarget
  | AwsDirectCfS3Target;

export interface AwsDirectLambdaTarget {
  mode: 'lambda';
  region?: string;
  functionName: string;
  /**
   * S3 location of the function code zip. The runner's CI is responsible
   * for uploading the zip — this adapter only flips Lambda to point at it.
   * `keyTemplate` may contain `${ref}` which is substituted with `opts.ref`.
   */
  s3Bucket: string;
  s3KeyTemplate: string;
  /** Optional alias to repoint after publish (e.g., `live`). */
  alias?: string;
  /**
   * Optional public URL used by `resolveUrlForRef`. Lambda's function URL
   * isn't ref-specific — pass through whatever DNS the operator put in
   * front of the function (Function URL or API Gateway).
   */
  publicUrl?: string;
}

export interface AwsDirectEcsTarget {
  mode: 'ecs';
  region?: string;
  cluster: string;
  service: string;
  /** Within the existing task def, which container to swap the image on. */
  containerName: string;
  /**
   * Image template — `${ref}` substituted at trigger time. Operators are
   * responsible for pushing the image to ECR before triggering, mirroring
   * the Fly adapter's externally-built-image convention.
   */
  imageTemplate: string;
  /** Optional public URL — usually the ALB DNS or the operator's CNAME. */
  publicUrl?: string;
}

export interface AwsDirectCfS3Target {
  mode: 'cf-s3';
  region?: string;
  distributionId: string;
  /** Paths to invalidate. Defaults to `['/*']`. */
  invalidationPaths?: string[];
  /**
   * Operators wire `aws s3 sync` into their CI; the adapter only fires
   * the CloudFront invalidation. This mirrors the convention every other
   * "image-style" adapter follows (Fly, ECS) — the artifact lands at a
   * pre-arranged location out-of-band, the adapter flips the pointer.
   */
  publicUrl?: string;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * AWS-direct deploy provider (#201).
 *
 * One adapter, three sub-modes selected on `target.config.mode`:
 *
 *   - `lambda`  — `UpdateFunctionCode` from S3 + optional alias repoint.
 *   - `ecs`     — register a new task def revision + `UpdateService`.
 *   - `cf-s3`   — `CreateInvalidation` against a CloudFront distribution.
 *
 * Each AWS SDK client is loaded lazily (`await import()`) inside the
 * methods that use it. The runner image only pays the ~few-hundred-KB
 * cost of the SDK packages it actually exercises, and projects that
 * never use AWS-direct don't pay anything beyond `@mergecrew/adapters-deploy`'s
 * existing baseline.
 *
 * Auth: static keys via the constructor or the SDK's default credential
 * chain. STS assume-role is intentionally out of scope for v0.1 — operators
 * with role-based deploys can pre-assume the role and pass the temporary
 * credentials in `accessKeyId / secretAccessKey / sessionToken`.
 */
export class AwsDirectProvider implements DeployProvider {
  readonly id = 'aws-direct' as const;
  private readonly defaultRegion: string | undefined;
  private readonly creds:
    | {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      }
    | undefined;

  constructor(cfg: AwsDirectConfig = {}) {
    this.defaultRegion = cfg.region;
    if (cfg.accessKeyId && cfg.secretAccessKey) {
      this.creds = {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        sessionToken: cfg.sessionToken,
      };
    }
  }

  // ─── DeployProvider ────────────────────────────────────────────────────────

  async triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    switch (cfg.mode) {
      case 'lambda':
        return this.triggerLambda(target, cfg, opts);
      case 'ecs':
        return this.triggerEcs(target, cfg, opts);
      case 'cf-s3':
        return this.triggerCfS3(target, cfg, opts);
      default:
        throw new Error(`aws-direct: unsupported mode in target config`);
    }
  }

  async getStatus(handle: DeployHandle): Promise<DeployStatus> {
    const meta = parseExternalRunId(handle.externalRunId);
    switch (meta.mode) {
      case 'lambda':
        return this.statusLambda(meta);
      case 'ecs':
        return this.statusEcs(meta);
      case 'cf-s3':
        return this.statusCfS3(meta);
    }
  }

  async awaitCompletion(handle: DeployHandle, timeoutMs: number, abort: AbortSignal): Promise<DeployResult> {
    const deadline = Date.now() + timeoutMs;
    let delay = 4_000;
    while (!abort.aborted && Date.now() < deadline) {
      const s = await this.getStatus(handle);
      if (s.kind === 'success' || s.kind === 'failed' || s.kind === 'cancelled') {
        return { status: s, url: (s as { url?: string }).url };
      }
      await sleep(Math.min(delay, deadline - Date.now()));
      delay = Math.min(delay * 1.4, 15_000);
    }
    return {
      status: { kind: 'failed', reason: 'timeout', finishedAt: new Date().toISOString() },
    };
  }

  async resolveUrlForRef(target: DeployTargetRef, _ref: string): Promise<string | null> {
    const cfg = this.cfgFrom(target);
    return cfg.publicUrl ?? null;
  }

  async fetchLogs(_handle: DeployHandle, _opts: { sinceMs?: number; tailLines?: number }): Promise<LogChunk[]> {
    // CloudWatch Logs is the right surface here, but auth + log-group
    // discovery is per-mode and fiddly enough that operators tail in the
    // AWS console for v0.1. Returning empty matches the Render adapter.
    return [];
  }

  async rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle> {
    const cfg = this.cfgFrom(target);
    switch (cfg.mode) {
      case 'lambda':
        return this.rollbackLambda(target, cfg, toRef);
      case 'ecs':
        // ECS rollback re-runs triggerDeploy with the previous SHA — same
        // task def family + image template, just a different ref.
        return this.triggerEcs(target, cfg, {
          ref: toRef,
          branch: '',
          correlationId: `rollback-${toRef}`,
        });
      case 'cf-s3':
        // Static-asset rollback requires re-uploading the previous build,
        // which lives outside this adapter. Fail loudly so operators don't
        // silently invalidate the current (broken) cache.
        throw new Error(
          'aws-direct(cf-s3): rollback is operator-managed — re-sync prior assets, then invalidate',
        );
    }
  }

  // ─── Mode: Lambda ──────────────────────────────────────────────────────────

  private async triggerLambda(
    _target: DeployTargetRef,
    cfg: AwsDirectLambdaTarget,
    opts: DeployOpts,
  ): Promise<DeployHandle> {
    const lambda = await this.lambdaClient(cfg.region);
    const { UpdateFunctionCodeCommand, UpdateAliasCommand } = await import('@aws-sdk/client-lambda');
    const s3Key = cfg.s3KeyTemplate.replaceAll('${ref}', opts.ref);
    const updated = (await lambda.send(
      new UpdateFunctionCodeCommand({
        FunctionName: cfg.functionName,
        S3Bucket: cfg.s3Bucket,
        S3Key: s3Key,
        Publish: true,
      }),
    )) as { Version?: string };
    const version = updated.Version ?? '$LATEST';
    if (cfg.alias) {
      await lambda.send(
        new UpdateAliasCommand({
          FunctionName: cfg.functionName,
          Name: cfg.alias,
          FunctionVersion: version,
        }),
      );
    }
    return {
      externalRunId: encodeExternalRunId({
        mode: 'lambda',
        region: cfg.region ?? this.defaultRegion,
        functionName: cfg.functionName,
        version,
      }),
      targetId: _target.id,
      correlationId: opts.correlationId,
    };
  }

  private async statusLambda(meta: ParsedRunId<'lambda'>): Promise<DeployStatus> {
    const lambda = await this.lambdaClient(meta.region);
    const { GetFunctionCommand } = await import('@aws-sdk/client-lambda');
    const r = (await lambda.send(
      new GetFunctionCommand({
        FunctionName: meta.functionName,
        Qualifier: meta.version,
      }),
    )) as {
      Configuration?: {
        LastUpdateStatus?: string;
        LastUpdateStatusReason?: string;
        LastModified?: string;
      };
    };
    const c = r.Configuration ?? {};
    switch (c.LastUpdateStatus) {
      case 'Successful':
        return {
          kind: 'success',
          url: '',
          finishedAt: c.LastModified ?? new Date().toISOString(),
        };
      case 'Failed':
        return {
          kind: 'failed',
          reason: c.LastUpdateStatusReason ?? 'lambda update failed',
          finishedAt: new Date().toISOString(),
        };
      case 'InProgress':
        return { kind: 'in_progress', latestStep: 'lambda update' };
      default:
        return { kind: 'queued' };
    }
  }

  private async rollbackLambda(
    target: DeployTargetRef,
    cfg: AwsDirectLambdaTarget,
    toVersion: string,
  ): Promise<DeployHandle> {
    if (!cfg.alias) {
      throw new Error('aws-direct(lambda): rollback requires `alias` to be configured');
    }
    const lambda = await this.lambdaClient(cfg.region);
    const { UpdateAliasCommand } = await import('@aws-sdk/client-lambda');
    await lambda.send(
      new UpdateAliasCommand({
        FunctionName: cfg.functionName,
        Name: cfg.alias,
        FunctionVersion: toVersion,
      }),
    );
    return {
      externalRunId: encodeExternalRunId({
        mode: 'lambda',
        region: cfg.region ?? this.defaultRegion,
        functionName: cfg.functionName,
        version: toVersion,
      }),
      targetId: target.id,
      correlationId: `rollback-${toVersion}`,
    };
  }

  // ─── Mode: ECS ─────────────────────────────────────────────────────────────

  private async triggerEcs(
    target: DeployTargetRef,
    cfg: AwsDirectEcsTarget,
    opts: DeployOpts,
  ): Promise<DeployHandle> {
    const ecs = await this.ecsClient(cfg.region);
    const { DescribeServicesCommand, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand, UpdateServiceCommand } =
      await import('@aws-sdk/client-ecs');

    const svcDescribe = (await ecs.send(
      new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
    )) as { services?: Array<{ taskDefinition?: string }> };
    const currentTaskDef = svcDescribe.services?.[0]?.taskDefinition;
    if (!currentTaskDef) {
      throw new Error(`aws-direct(ecs): service ${cfg.service} not found in cluster ${cfg.cluster}`);
    }

    const td = (await ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: currentTaskDef }),
    )) as { taskDefinition?: EcsTaskDefinition };
    const current = td.taskDefinition;
    if (!current) throw new Error('aws-direct(ecs): could not describe current task definition');

    const newImage = cfg.imageTemplate.replaceAll('${ref}', opts.ref);
    const containers = (current.containerDefinitions ?? []).map((c) =>
      c.name === cfg.containerName ? { ...c, image: newImage } : c,
    );
    if (!containers.some((c) => c.name === cfg.containerName)) {
      throw new Error(
        `aws-direct(ecs): container "${cfg.containerName}" not found in task def ${current.family}`,
      );
    }

    // The SDK's RegisterTaskDefinitionInput uses narrowed enum types
    // (NetworkMode, Compatibility, …). DescribeTaskDefinition gives us the
    // raw strings, and round-tripping them through the input type would
    // require importing the enums at module-load — which defeats the
    // lazy-load. Cast at the boundary; the values came from AWS itself
    // so the runtime contract is satisfied.
    const registered = (await ecs.send(
      new RegisterTaskDefinitionCommand({
        family: current.family,
        taskRoleArn: current.taskRoleArn,
        executionRoleArn: current.executionRoleArn,
        networkMode: current.networkMode,
        containerDefinitions: containers,
        volumes: current.volumes,
        placementConstraints: current.placementConstraints,
        requiresCompatibilities: current.requiresCompatibilities,
        cpu: current.cpu,
        memory: current.memory,
        runtimePlatform: current.runtimePlatform,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    )) as { taskDefinition?: { taskDefinitionArn?: string } };
    const newArn = registered.taskDefinition?.taskDefinitionArn;
    if (!newArn) throw new Error('aws-direct(ecs): RegisterTaskDefinition returned no ARN');

    await ecs.send(
      new UpdateServiceCommand({
        cluster: cfg.cluster,
        service: cfg.service,
        taskDefinition: newArn,
        forceNewDeployment: true,
      }),
    );

    return {
      externalRunId: encodeExternalRunId({
        mode: 'ecs',
        region: cfg.region ?? this.defaultRegion,
        cluster: cfg.cluster,
        service: cfg.service,
        taskDefArn: newArn,
      }),
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  private async statusEcs(meta: ParsedRunId<'ecs'>): Promise<DeployStatus> {
    const ecs = await this.ecsClient(meta.region);
    const { DescribeServicesCommand } = await import('@aws-sdk/client-ecs');
    const r = (await ecs.send(
      new DescribeServicesCommand({ cluster: meta.cluster, services: [meta.service] }),
    )) as {
      services?: Array<{
        deployments?: Array<{
          taskDefinition?: string;
          status?: string;
          runningCount?: number;
          desiredCount?: number;
          failedTasks?: number;
          updatedAt?: string;
        }>;
      }>;
    };
    const deployments = r.services?.[0]?.deployments ?? [];
    const ours = deployments.find((d) => d.taskDefinition === meta.taskDefArn);
    if (!ours) return { kind: 'queued' };
    if ((ours.failedTasks ?? 0) > 0) {
      return {
        kind: 'failed',
        reason: `ecs deployment had ${ours.failedTasks} failed tasks`,
        finishedAt: new Date().toISOString(),
      };
    }
    const running = ours.runningCount ?? 0;
    const desired = ours.desiredCount ?? 0;
    if (ours.status === 'PRIMARY' && desired > 0 && running === desired) {
      return {
        kind: 'success',
        url: '',
        finishedAt: ours.updatedAt ?? new Date().toISOString(),
      };
    }
    return {
      kind: 'in_progress',
      latestStep: `ecs ${ours.status ?? 'pending'} (${running}/${desired})`,
    };
  }

  // ─── Mode: CloudFront + S3 ─────────────────────────────────────────────────

  private async triggerCfS3(
    target: DeployTargetRef,
    cfg: AwsDirectCfS3Target,
    opts: DeployOpts,
  ): Promise<DeployHandle> {
    const cf = await this.cloudFrontClient(cfg.region);
    const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
    const paths = cfg.invalidationPaths ?? ['/*'];
    // CallerReference must be unique per invalidation; the runner's
    // correlationId is already required-unique, so reuse it.
    const r = (await cf.send(
      new CreateInvalidationCommand({
        DistributionId: cfg.distributionId,
        InvalidationBatch: {
          CallerReference: opts.correlationId,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    )) as { Invalidation?: { Id?: string } };
    const id = r.Invalidation?.Id;
    if (!id) throw new Error('aws-direct(cf-s3): CreateInvalidation returned no Id');
    return {
      externalRunId: encodeExternalRunId({
        mode: 'cf-s3',
        region: cfg.region ?? this.defaultRegion,
        distributionId: cfg.distributionId,
        invalidationId: id,
      }),
      targetId: target.id,
      correlationId: opts.correlationId,
    };
  }

  private async statusCfS3(meta: ParsedRunId<'cf-s3'>): Promise<DeployStatus> {
    const cf = await this.cloudFrontClient(meta.region);
    const { GetInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
    const r = (await cf.send(
      new GetInvalidationCommand({ DistributionId: meta.distributionId, Id: meta.invalidationId }),
    )) as { Invalidation?: { Status?: string } };
    const status = r.Invalidation?.Status;
    if (status === 'Completed') {
      return { kind: 'success', url: '', finishedAt: new Date().toISOString() };
    }
    if (status === 'InProgress') {
      return { kind: 'in_progress', latestStep: 'cloudfront invalidation' };
    }
    return { kind: 'queued' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private cfgFrom(target: DeployTargetRef): AwsDirectTargetConfig {
    const c = target.config as unknown as AwsDirectTargetConfig;
    if (!c || typeof c !== 'object' || !('mode' in c)) {
      throw new Error('aws-direct: target.config must have a "mode" discriminator');
    }
    return c;
  }

  private clientOpts(region: string | undefined): { region: string; credentials?: AwsCreds } {
    const r = region ?? this.defaultRegion;
    if (!r) throw new Error('aws-direct: region is required (target config or constructor)');
    return this.creds ? { region: r, credentials: this.creds } : { region: r };
  }

  private async lambdaClient(region: string | undefined) {
    const { LambdaClient } = await import('@aws-sdk/client-lambda');
    return new LambdaClient(this.clientOpts(region));
  }

  private async ecsClient(region: string | undefined) {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    return new ECSClient(this.clientOpts(region));
  }

  private async cloudFrontClient(region: string | undefined) {
    const { CloudFrontClient } = await import('@aws-sdk/client-cloudfront');
    // CloudFront is a global service but the SDK still wants a region; the
    // canonical choice is us-east-1 since that's where the API lives.
    return new CloudFrontClient(this.clientOpts(region ?? 'us-east-1'));
  }
}

// ─── Internal: encoded externalRunId ─────────────────────────────────────────
//
// `DeployHandle.externalRunId` is a single string that has to round-trip the
// per-mode metadata `getStatus` needs. Stuffing it as JSON keeps the type
// narrowed locally without bleeding extra fields into the cross-adapter
// `DeployHandle` shape.

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface EcsTaskDefinition {
  family?: string;
  taskRoleArn?: string;
  executionRoleArn?: string;
  networkMode?: string;
  containerDefinitions?: Array<{ name?: string; image?: string }>;
  volumes?: unknown[];
  placementConstraints?: unknown[];
  requiresCompatibilities?: string[];
  cpu?: string;
  memory?: string;
  runtimePlatform?: unknown;
}

type ParsedRunId<M extends 'lambda' | 'ecs' | 'cf-s3'> = M extends 'lambda'
  ? { mode: 'lambda'; region?: string; functionName: string; version: string }
  : M extends 'ecs'
    ? { mode: 'ecs'; region?: string; cluster: string; service: string; taskDefArn: string }
    : { mode: 'cf-s3'; region?: string; distributionId: string; invalidationId: string };

function encodeExternalRunId(meta: ParsedRunId<'lambda'> | ParsedRunId<'ecs'> | ParsedRunId<'cf-s3'>): string {
  return `aws:${JSON.stringify(meta)}`;
}

function parseExternalRunId(s: string): ParsedRunId<'lambda'> | ParsedRunId<'ecs'> | ParsedRunId<'cf-s3'> {
  if (!s.startsWith('aws:')) throw new Error(`aws-direct: not our externalRunId: ${s}`);
  return JSON.parse(s.slice(4)) as ParsedRunId<'lambda'> | ParsedRunId<'ecs'> | ParsedRunId<'cf-s3'>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
