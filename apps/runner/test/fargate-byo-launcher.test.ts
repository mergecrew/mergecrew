import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { mintEphemeralAgent } from '../src/fargate-byo-launcher.js';

const logger = pino({ level: 'silent' });

vi.mock('@mergecrew/db', () => ({
  withSystem: (fn: any) =>
    fn({
      runnerAgent: {
        create: async ({ data }: any) => ({
          id: 'fake-agent-id',
          ...data,
        }),
      },
    }),
}));

const stsSendMock = vi.fn();
const ecsSendMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: stsSendMock })),
  AssumeRoleCommand: vi.fn().mockImplementation((args: unknown) => ({ kind: 'AssumeRole', args })),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  RunTaskCommand: vi.fn().mockImplementation((args: unknown) => ({ kind: 'RunTask', args })),
}));

afterEach(() => {
  stsSendMock.mockReset();
  ecsSendMock.mockReset();
});

describe('mintEphemeralAgent', () => {
  it('generates a mca_<orgSlug>_<base32> token and returns plaintext + agent row', async () => {
    const r = await mintEphemeralAgent({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      stepId: 'step-xyz',
      source: 'fargate',
    });
    expect(r.token).toMatch(/^mca_acme_[A-Z2-7]{26}$/);
    expect(r.agentId).toBe('fake-agent-id');
  });

  it('uses a per-step name so multiple fargate dispatches do not collide', async () => {
    const created: any[] = [];
    vi.doMock('@mergecrew/db', () => ({
      withSystem: (fn: any) =>
        fn({
          runnerAgent: {
            create: async (args: any) => {
              created.push(args);
              return { id: 'fake-id', ...args.data };
            },
          },
        }),
    }));
    // Re-import after re-mocking.
    vi.resetModules();
    const { mintEphemeralAgent: mintFresh } = await import('../src/agent-tokens.js');
    await mintFresh({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      stepId: 'step-a',
      source: 'fargate',
    });
    await mintFresh({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      stepId: 'step-b',
      source: 'fargate',
    });
    expect(created[0]!.data.name).toBe('fargate-step-step-a');
    expect(created[1]!.data.name).toBe('fargate-step-step-b');
  });
});

describe('launchFargateAgent — AWS SDK contract', () => {
  // Use a separate import per test because vi.resetModules() inside a
  // test wipes the in-test reference. We pre-import here.
  it('calls AssumeRole with role ARN + external ID and uses returned creds for ECS', async () => {
    stsSendMock.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKIA-FAKE',
        SecretAccessKey: 'fake-secret',
        SessionToken: 'fake-session',
        Expiration: new Date(),
      },
    });
    ecsSendMock.mockResolvedValueOnce({
      tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123:task/cluster/abc' }],
      failures: [],
    });
    const { launchFargateAgent } = await import('../src/fargate-byo-launcher.js');
    const r = await launchFargateAgent({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      stepId: 'step-1',
      runId: 'run-1',
      profile: {
        awsRoleArn: 'arn:aws:iam::123456789012:role/mergecrew-runner',
        awsExternalId: 'ext-uuid',
        awsRegion: 'us-east-1',
        fargateCluster: 'mergecrew-cluster',
        fargateTaskDefinition: 'mergecrew-task:1',
        fargateSubnets: ['subnet-a'],
        fargateSecurityGroups: ['sg-a'],
      },
      apiBaseUrl: 'https://mergecrew.dev',
      logger,
    });
    expect(r.taskArn).toContain('arn:aws:ecs:us-east-1');
    // AssumeRole shape
    const assumeCall = stsSendMock.mock.calls[0]![0];
    expect(assumeCall.args.RoleArn).toBe('arn:aws:iam::123456789012:role/mergecrew-runner');
    expect(assumeCall.args.ExternalId).toBe('ext-uuid');
    // RunTask shape
    const runCall = ecsSendMock.mock.calls[0]![0];
    expect(runCall.args.cluster).toBe('mergecrew-cluster');
    expect(runCall.args.taskDefinition).toBe('mergecrew-task:1');
    expect(runCall.args.launchType).toBe('FARGATE');
    // Token is in the container env (this is the security-sensitive
    // assertion — the token MUST reach the agent inside the task).
    const containerOverrides = runCall.args.overrides.containerOverrides[0];
    const envByName = Object.fromEntries(
      containerOverrides.environment.map((e: any) => [e.name, e.value]),
    );
    expect(envByName.MERGECREW_AGENT_TOKEN).toMatch(/^mca_acme_[A-Z2-7]{26}$/);
    expect(envByName.MERGECREW_API_URL).toBe('https://mergecrew.dev');
  });

  it('throws when AssumeRole returns incomplete credentials', async () => {
    stsSendMock.mockResolvedValueOnce({ Credentials: undefined });
    const { launchFargateAgent } = await import('../src/fargate-byo-launcher.js');
    await expect(
      launchFargateAgent({
        organizationId: 'org-1',
        organizationSlug: 'acme',
        stepId: 'step-1',
        runId: 'run-1',
        profile: {
          awsRoleArn: 'arn:aws:iam::123:role/r',
          awsExternalId: 'x',
          awsRegion: 'us-east-1',
          fargateCluster: 'c',
          fargateTaskDefinition: 't',
          fargateSubnets: [],
          fargateSecurityGroups: [],
        },
        apiBaseUrl: 'https://x',
        logger,
      }),
    ).rejects.toThrow(/incomplete credentials/);
  });

  it('throws with the AWS reason when RunTask returns no task arn', async () => {
    stsSendMock.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'a',
        SecretAccessKey: 'b',
        SessionToken: 'c',
      },
    });
    ecsSendMock.mockResolvedValueOnce({
      tasks: [],
      failures: [{ reason: 'CAPACITY' }],
    });
    const { launchFargateAgent } = await import('../src/fargate-byo-launcher.js');
    await expect(
      launchFargateAgent({
        organizationId: 'org-1',
        organizationSlug: 'acme',
        stepId: 'step-1',
        runId: 'run-1',
        profile: {
          awsRoleArn: 'arn:aws:iam::123:role/r',
          awsExternalId: 'x',
          awsRegion: 'us-east-1',
          fargateCluster: 'c',
          fargateTaskDefinition: 't',
          fargateSubnets: [],
          fargateSecurityGroups: [],
        },
        apiBaseUrl: 'https://x',
        logger,
      }),
    ).rejects.toThrow(/RunTask returned no taskArn.*CAPACITY/);
  });
});
