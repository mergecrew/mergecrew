import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { withSystem } from '@mergecrew/db';

/**
 * Launches an ECS task in the user's AWS account that runs
 * `mergecrew/runner-agent`, then returns so the supervisor can
 * proceed with its `HttpSandboxDriver` against the still-launching
 * agent (V2.ag step 6 / #786 / ADR-0007).
 *
 * Trust posture:
 *   - The supervisor does an STS:AssumeRole into the org's role
 *     using the per-org `awsExternalId` saved on the RunnerProfile
 *     row (ADR-0007). No long-lived AWS keys are stored on the
 *     deployment — every dispatch gets fresh hour-scoped creds.
 *   - The agent inside the ECS task receives a freshly-minted
 *     bearer token via the task's environment. The token is per-
 *     step ephemeral; the deployment writes only its sha256 hash
 *     to RunnerAgent (same shape as user-enrolled agents).
 *
 * Token-leak surface: the plaintext token transits ECS task env
 * vars. Visible to anyone in the user's AWS account with
 * `ecs:DescribeTasks` on the cluster. Acceptable for v1; moving
 * the token into AWS Secrets Manager / SSM Parameter Store is a
 * future PR.
 */

const TOKEN_PREFIX = 'mca_';
const TOKEN_SECRET_LENGTH = 26;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface FargateByoProfile {
  awsRoleArn: string;
  awsExternalId: string;
  awsRegion: string;
  fargateCluster: string;
  fargateTaskDefinition: string;
  fargateSubnets: string[];
  fargateSecurityGroups: string[];
}

export interface FargateLaunchArgs {
  organizationId: string;
  organizationSlug: string;
  stepId: string;
  runId: string;
  profile: FargateByoProfile;
  apiBaseUrl: string;
  logger: Logger;
}

export interface FargateLaunchResult {
  taskArn: string;
  agentId: string;
}

/**
 * Generate + persist an ephemeral RunnerAgent row whose plaintext
 * token is returned exactly once. Caller is responsible for not
 * logging the plaintext.
 */
export async function mintEphemeralAgent(args: {
  organizationId: string;
  organizationSlug: string;
  stepId: string;
}): Promise<{ token: string; agentId: string }> {
  const buf = randomBytes(TOKEN_SECRET_LENGTH);
  const secret = Array.from(buf, (b) => BASE32[b & 0x1f]!).join('');
  const token = `${TOKEN_PREFIX}${args.organizationSlug}_${secret}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, `${TOKEN_PREFIX}${args.organizationSlug}_`.length + 6);

  const row = await withSystem((tx) =>
    tx.runnerAgent.create({
      data: {
        organizationId: args.organizationId,
        name: `fargate-step-${args.stepId}`,
        tokenHash,
        prefix,
        // No createdByUserId — this is a system-generated agent for
        // a Fargate dispatch. The agents settings UI can filter
        // these out by name pattern.
      },
    }),
  );
  return { token, agentId: row.id };
}

/**
 * Assume the user's IAM role + launch the ECS task. Doesn't wait
 * for RUNNING — the agent inside the task phones home via /hello
 * → /poll, so the supervisor's HttpSandboxDriver wakes up
 * naturally once the agent picks up the claim from the per-org
 * queue.
 */
export async function launchFargateAgent(
  args: FargateLaunchArgs,
): Promise<FargateLaunchResult> {
  const { organizationId, organizationSlug, stepId, profile, apiBaseUrl, logger } = args;

  // Mint the ephemeral token first so a launch failure doesn't
  // leave a no-op task with no agent to talk to.
  const { token, agentId } = await mintEphemeralAgent({
    organizationId,
    organizationSlug,
    stepId,
  });

  // Lazy-load the SDK clients so the unsandboxed instance-builtin
  // codepath stays SDK-free at startup.
  const stsModule = await import('@aws-sdk/client-sts');
  const sts = new stsModule.STSClient({ region: profile.awsRegion });
  const assumed = await sts.send(
    new stsModule.AssumeRoleCommand({
      RoleArn: profile.awsRoleArn,
      RoleSessionName: `mergecrew-${organizationSlug}-${stepId}`,
      ExternalId: profile.awsExternalId,
      DurationSeconds: 3600,
    }),
  );
  const creds = assumed.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error('fargate-byo: STS AssumeRole returned incomplete credentials');
  }

  const ecsModule = await import('@aws-sdk/client-ecs');
  const ecs = new ecsModule.ECSClient({
    region: profile.awsRegion,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });

  const r = await ecs.send(
    new ecsModule.RunTaskCommand({
      cluster: profile.fargateCluster,
      taskDefinition: profile.fargateTaskDefinition,
      launchType: 'FARGATE',
      count: 1,
      tags: [
        { key: 'mergecrew:org', value: organizationSlug },
        { key: 'mergecrew:step', value: stepId },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: profile.fargateSubnets,
          securityGroups: profile.fargateSecurityGroups.length > 0
            ? profile.fargateSecurityGroups
            : undefined,
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'runner-agent',
            environment: [
              { name: 'MERGECREW_AGENT_TOKEN', value: token },
              { name: 'MERGECREW_API_URL', value: apiBaseUrl },
              { name: 'MERGECREW_AGENT_NAME', value: `fargate-${stepId}` },
              { name: 'MERGECREW_AGENT_DRIVER', value: 'process' },
            ],
          },
        ],
      },
    }),
  );

  const taskArn = r.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const reason = r.failures?.[0]?.reason ?? 'unknown';
    throw new Error(`fargate-byo: RunTask returned no taskArn (${reason})`);
  }
  logger.info(
    { stepId, taskArn, agentId, region: profile.awsRegion },
    'fargate-byo: ECS task launched; awaiting agent /hello',
  );
  return { taskArn, agentId };
}
