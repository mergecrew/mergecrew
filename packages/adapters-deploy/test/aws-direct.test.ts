/**
 * Conformance tests for the AWS-direct deploy adapter (V2.2, #201).
 *
 * Three modes — Lambda, ECS, CloudFront+S3 — share one provider class.
 * Each gets a `describe` block. We mock the SDK clients at the
 * `client.send()` seam, mirroring the AWS SDK testing guidance: the
 * ` *Command` constructors are pure data, so we don't need to assert on
 * them — we just queue responses for `send()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsDirectProvider } from '../src/aws-direct.js';
import {
  expectValidHandle,
  expectValidResult,
  expectValidStatus,
  makeTarget,
} from './conformance.js';

// We swap each SDK module with a fake whose Client classes capture the
// `send` calls. `vi.hoisted` keeps the mocks accessible from outside the
// `vi.mock` factory while still being hoisted to the top of the file.
const m = vi.hoisted(() => {
  const lambdaSend = vi.fn();
  const ecsSend = vi.fn();
  const cfSend = vi.fn();
  return { lambdaSend, ecsSend, cfSend };
});

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = m.lambdaSend;
  },
  UpdateFunctionCodeCommand: class {
    constructor(public input: unknown) {}
  },
  GetFunctionCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateAliasCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: class {
    send = m.ecsSend;
  },
  DescribeServicesCommand: class {
    constructor(public input: unknown) {}
  },
  DescribeTaskDefinitionCommand: class {
    constructor(public input: unknown) {}
  },
  RegisterTaskDefinitionCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateServiceCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    send = m.cfSend;
  },
  CreateInvalidationCommand: class {
    constructor(public input: unknown) {}
  },
  GetInvalidationCommand: class {
    constructor(public input: unknown) {}
  },
}));

let provider: AwsDirectProvider;

beforeEach(() => {
  provider = new AwsDirectProvider({
    region: 'us-west-2',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
  });
  m.lambdaSend.mockReset();
  m.ecsSend.mockReset();
  m.cfSend.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Lambda ──────────────────────────────────────────────────────────────────

describe('AwsDirectProvider — lambda', () => {
  const target = makeTarget('aws-direct', {
    mode: 'lambda',
    region: 'us-west-2',
    functionName: 'my-fn',
    s3Bucket: 'artifacts',
    s3KeyTemplate: 'builds/${ref}.zip',
    publicUrl: 'https://my-fn.example.com',
  });

  it('triggerDeploy publishes a new version and returns a well-shaped DeployHandle', async () => {
    m.lambdaSend.mockResolvedValueOnce({ Version: '7' });
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha-abc',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-1' });
    // The S3 key template must have been substituted with the ref.
    const cmd = m.lambdaSend.mock.calls[0]?.[0] as { input?: { S3Key?: string } };
    expect(cmd.input?.S3Key).toBe('builds/sha-abc.zip');
  });

  it('triggerDeploy repoints the alias when configured', async () => {
    const aliased = makeTarget('aws-direct', {
      mode: 'lambda',
      region: 'us-west-2',
      functionName: 'my-fn',
      s3Bucket: 'artifacts',
      s3KeyTemplate: 'builds/${ref}.zip',
      alias: 'live',
    });
    m.lambdaSend.mockResolvedValueOnce({ Version: '7' });
    m.lambdaSend.mockResolvedValueOnce({}); // UpdateAlias
    await provider.triggerDeploy(aliased, {
      ref: 'sha-abc',
      branch: 'main',
      correlationId: 'corr-1',
    });
    expect(m.lambdaSend.mock.calls.length).toBe(2);
    const aliasCmd = m.lambdaSend.mock.calls[1]?.[0] as {
      input?: { Name?: string; FunctionVersion?: string };
    };
    expect(aliasCmd.input?.Name).toBe('live');
    expect(aliasCmd.input?.FunctionVersion).toBe('7');
  });

  it('getStatus maps each LastUpdateStatus value to a valid DeployStatus', async () => {
    m.lambdaSend.mockResolvedValueOnce({ Version: '1' }); // trigger
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    const cases = [
      { backend: 'Successful', kind: 'success' },
      { backend: 'Failed', kind: 'failed' },
      { backend: 'InProgress', kind: 'in_progress' },
    ];
    for (const c of cases) {
      m.lambdaSend.mockResolvedValueOnce({
        Configuration: {
          LastUpdateStatus: c.backend,
          LastUpdateStatusReason: 'because',
          LastModified: '2026-05-10T00:00:00Z',
        },
      });
      const s = await provider.getStatus(handle);
      expect(s.kind, `backend=${c.backend}`).toBe(c.kind);
      expectValidStatus(s);
    }
  });

  it('awaitCompletion returns success when the first poll already shows Successful', async () => {
    m.lambdaSend.mockResolvedValueOnce({ Version: '1' });
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    m.lambdaSend.mockResolvedValueOnce({
      Configuration: { LastUpdateStatus: 'Successful', LastModified: '2026-05-10T00:00:00Z' },
    });
    const result = await provider.awaitCompletion(handle, 30_000, new AbortController().signal);
    expectValidResult(result);
    expect(result.status.kind).toBe('success');
  });

  it('resolveUrlForRef returns the configured publicUrl', async () => {
    expect(await provider.resolveUrlForRef(target, 'any-sha')).toBe('https://my-fn.example.com');
  });

  it('rollbackProduction repoints the alias to the previous version', async () => {
    const aliased = makeTarget('aws-direct', {
      mode: 'lambda',
      region: 'us-west-2',
      functionName: 'my-fn',
      s3Bucket: 'artifacts',
      s3KeyTemplate: 'builds/${ref}.zip',
      alias: 'live',
    });
    m.lambdaSend.mockResolvedValueOnce({});
    const handle = await provider.rollbackProduction(aliased, '5');
    expect(handle.targetId).toBe(aliased.id);
    expect(typeof handle.correlationId).toBe('string');
    const cmd = m.lambdaSend.mock.calls[0]?.[0] as { input?: { FunctionVersion?: string } };
    expect(cmd.input?.FunctionVersion).toBe('5');
  });

  it('rollback without alias throws a clear error', async () => {
    await expect(provider.rollbackProduction(target, '5')).rejects.toThrow(/alias/);
  });
});

// ─── ECS ─────────────────────────────────────────────────────────────────────

describe('AwsDirectProvider — ecs', () => {
  const target = makeTarget('aws-direct', {
    mode: 'ecs',
    region: 'us-west-2',
    cluster: 'prod',
    service: 'web',
    containerName: 'app',
    imageTemplate: '111111111111.dkr.ecr.us-west-2.amazonaws.com/web:${ref}',
    publicUrl: 'https://web.example.com',
  });

  it('triggerDeploy registers a new task def with the substituted image and updates the service', async () => {
    m.ecsSend.mockResolvedValueOnce({
      services: [{ taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:5' }],
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'web',
        containerDefinitions: [
          { name: 'app', image: 'old:image' },
          { name: 'sidecar', image: 'sidecar:1' },
        ],
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
      },
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-west-2:111:task-definition/web:6' },
    });
    m.ecsSend.mockResolvedValueOnce({});
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha-abc',
      branch: 'main',
      correlationId: 'corr-2',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-2' });

    // RegisterTaskDefinition is the third call (after Describe x2).
    const reg = m.ecsSend.mock.calls[2]?.[0] as {
      input?: { containerDefinitions?: Array<{ name?: string; image?: string }> };
    };
    const app = reg.input?.containerDefinitions?.find((c) => c.name === 'app');
    const sidecar = reg.input?.containerDefinitions?.find((c) => c.name === 'sidecar');
    expect(app?.image).toBe('111111111111.dkr.ecr.us-west-2.amazonaws.com/web:sha-abc');
    expect(sidecar?.image).toBe('sidecar:1'); // untouched

    // UpdateService is the fourth call.
    const upd = m.ecsSend.mock.calls[3]?.[0] as { input?: { taskDefinition?: string } };
    expect(upd.input?.taskDefinition).toBe('arn:aws:ecs:us-west-2:111:task-definition/web:6');
  });

  it('throws when the configured container name is not in the task definition', async () => {
    m.ecsSend.mockResolvedValueOnce({
      services: [{ taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:5' }],
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'web',
        containerDefinitions: [{ name: 'sidecar', image: 'sidecar:1' }],
      },
    });
    await expect(
      provider.triggerDeploy(target, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/container "app"/);
  });

  it('getStatus reports success when running == desired and PRIMARY', async () => {
    // First do a triggerDeploy to obtain a real handle whose externalRunId
    // carries the new task def ARN.
    m.ecsSend.mockResolvedValueOnce({
      services: [{ taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:5' }],
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'web',
        containerDefinitions: [{ name: 'app', image: 'old:image' }],
      },
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-west-2:111:task-definition/web:6' },
    });
    m.ecsSend.mockResolvedValueOnce({});
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    m.ecsSend.mockResolvedValueOnce({
      services: [
        {
          deployments: [
            {
              status: 'PRIMARY',
              taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:6',
              runningCount: 2,
              desiredCount: 2,
              failedTasks: 0,
              updatedAt: '2026-05-10T00:00:00Z',
            },
          ],
        },
      ],
    });
    const s = await provider.getStatus(handle);
    expectValidStatus(s);
    expect(s.kind).toBe('success');
  });

  it('getStatus reports failed when failedTasks > 0', async () => {
    m.ecsSend.mockResolvedValueOnce({
      services: [{ taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:5' }],
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'web',
        containerDefinitions: [{ name: 'app', image: 'old:image' }],
      },
    });
    m.ecsSend.mockResolvedValueOnce({
      taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-west-2:111:task-definition/web:6' },
    });
    m.ecsSend.mockResolvedValueOnce({});
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    m.ecsSend.mockResolvedValueOnce({
      services: [
        {
          deployments: [
            {
              status: 'PRIMARY',
              taskDefinition: 'arn:aws:ecs:us-west-2:111:task-definition/web:6',
              runningCount: 0,
              desiredCount: 2,
              failedTasks: 3,
            },
          ],
        },
      ],
    });
    const s = await provider.getStatus(handle);
    expect(s.kind).toBe('failed');
    expectValidStatus(s);
  });

  it('resolveUrlForRef returns the configured publicUrl', async () => {
    expect(await provider.resolveUrlForRef(target, 'any-sha')).toBe('https://web.example.com');
  });
});

// ─── CloudFront + S3 ─────────────────────────────────────────────────────────

describe('AwsDirectProvider — cf-s3', () => {
  const target = makeTarget('aws-direct', {
    mode: 'cf-s3',
    region: 'us-east-1',
    distributionId: 'EXYZ123',
    invalidationPaths: ['/*'],
    publicUrl: 'https://www.example.com',
  });

  it('triggerDeploy creates an invalidation and returns a well-shaped DeployHandle', async () => {
    m.cfSend.mockResolvedValueOnce({ Invalidation: { Id: 'I123' } });
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'corr-3',
    });
    expectValidHandle(handle, { targetId: target.id, correlationId: 'corr-3' });
    const cmd = m.cfSend.mock.calls[0]?.[0] as {
      input?: { InvalidationBatch?: { CallerReference?: string; Paths?: { Items?: string[] } } };
    };
    expect(cmd.input?.InvalidationBatch?.CallerReference).toBe('corr-3');
    expect(cmd.input?.InvalidationBatch?.Paths?.Items).toEqual(['/*']);
  });

  it('getStatus maps Completed to success and InProgress to in_progress', async () => {
    m.cfSend.mockResolvedValueOnce({ Invalidation: { Id: 'I123' } });
    const handle = await provider.triggerDeploy(target, {
      ref: 'sha',
      branch: 'main',
      correlationId: 'c',
    });
    m.cfSend.mockResolvedValueOnce({ Invalidation: { Status: 'InProgress' } });
    const inFlight = await provider.getStatus(handle);
    expect(inFlight.kind).toBe('in_progress');
    m.cfSend.mockResolvedValueOnce({ Invalidation: { Status: 'Completed' } });
    const done = await provider.getStatus(handle);
    expect(done.kind).toBe('success');
    expectValidStatus(done);
  });

  it('rollback for cf-s3 throws to surface that re-uploading is operator-managed', async () => {
    await expect(provider.rollbackProduction(target, 'old-sha')).rejects.toThrow(/operator-managed/);
  });

  it('resolveUrlForRef returns the configured publicUrl', async () => {
    expect(await provider.resolveUrlForRef(target, 'any')).toBe('https://www.example.com');
  });
});

// ─── Surface ─────────────────────────────────────────────────────────────────

describe('AwsDirectProvider — surface', () => {
  it('exposes id "aws-direct"', () => {
    expect(provider.id).toBe('aws-direct');
  });

  it('throws on a target whose config is missing the mode discriminator', async () => {
    const broken = makeTarget('aws-direct', { foo: 'bar' });
    await expect(
      provider.triggerDeploy(broken, { ref: 'sha', branch: 'main', correlationId: 'c' }),
    ).rejects.toThrow(/mode/);
  });
});
