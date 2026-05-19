/**
 * Real AWS SDK adapter for the FargateDriver (#578).
 *
 * Kept in its own module so the driver is unit-testable against an
 * in-memory fake (see `test/fargate-driver.spec.ts`). The SSM session
 * machinery used by `executeCommand` is the messy part: ECS hands us a
 * presigned WebSocket URL via the `execute-command` API, and the
 * actual stream is the SSM agent's binary protocol. For V0 we wrap
 * `awscli` (`aws ecs execute-command --interactive`) via execa; pure-
 * Node session streaming lands in a follow-up. The seam is `executeCommand`
 * — operators can swap implementations without touching the driver.
 */

import type {
  FargateApiClient,
  FargateRunTaskSpec,
} from './fargate-driver.js';

export interface FargateClientOpts {
  region: string;
  /**
   * AWS CLI binary used for `execute-command --interactive`. Default
   * 'aws'; operators on older builds set 'aws2'.
   */
  awsCliBin?: string;
}

export async function buildFargateApiClient(
  opts: FargateClientOpts,
): Promise<FargateApiClient> {
  const ecsModule = await import('@aws-sdk/client-ecs');
  const ecs = new ecsModule.ECSClient({ region: opts.region });
  const { execa } = await import('execa');
  const awsCli = opts.awsCliBin ?? 'aws';

  return {
    async runTask(spec: FargateRunTaskSpec): Promise<string> {
      const containerOverrides: Record<string, unknown> = { name: 'sandbox' };
      if (spec.overrides.command) containerOverrides.command = spec.overrides.command;
      if (spec.overrides.image) containerOverrides.image = spec.overrides.image;
      if (spec.overrides.environment) {
        containerOverrides.environment = Object.entries(spec.overrides.environment).map(
          ([name, value]) => ({ name, value }),
        );
      }
      const r = await ecs.send(
        new ecsModule.RunTaskCommand({
          cluster: spec.cluster,
          taskDefinition: spec.taskDefinition,
          launchType: 'FARGATE',
          enableExecuteCommand: true,
          count: 1,
          tags: Object.entries(spec.tags).map(([key, value]) => ({ key, value })),
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: spec.subnets,
              securityGroups: spec.securityGroups,
              assignPublicIp: spec.assignPublicIp ? 'ENABLED' : 'DISABLED',
            },
          },
          overrides: {
            containerOverrides: [containerOverrides as any],
            cpu: spec.overrides.cpu != null ? String(spec.overrides.cpu * 1024) : undefined,
            memory: spec.overrides.memoryMb != null ? String(spec.overrides.memoryMb) : undefined,
          },
        }),
      );
      const taskArn = r.tasks?.[0]?.taskArn;
      if (!taskArn) {
        const reason = r.failures?.[0]?.reason ?? 'unknown';
        throw new Error(`fargate runTask returned no task arn: ${reason}`);
      }
      return taskArn;
    },

    async waitForTaskRunning(taskArn: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await ecs.send(
          new ecsModule.DescribeTasksCommand({
            cluster: taskArn.split('/').slice(0, -1).join('/').replace(/:task$/, ''),
            tasks: [taskArn],
          }),
        );
        const status = r.tasks?.[0]?.lastStatus;
        if (status === 'RUNNING') return;
        if (status === 'STOPPED') {
          const reason = r.tasks?.[0]?.stoppedReason ?? 'unknown';
          throw new Error(`fargate task stopped before RUNNING: ${reason}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error(`fargate task ${taskArn} did not become RUNNING within ${timeoutMs}ms`);
    },

    async executeCommand(taskArn, cmd, execOpts) {
      // Shell out to `aws ecs execute-command --interactive` because the
      // SSM session protocol is non-trivial to implement in pure Node.
      // This path requires the operator to have the AWS CLI v2 +
      // `session-manager-plugin` installed on the supervisor host —
      // documented in 26-runner-fargate.md.
      const cluster = extractClusterFromArn(taskArn);
      const taskId = taskArn.split('/').pop()!;
      // Wrap the full command in `sh -c` so it's a single arg to --command.
      const command = ['sh', '-c', cmd.slice(2).join(' ')].join(' ');
      const args = [
        'ecs',
        'execute-command',
        '--cluster',
        cluster,
        '--task',
        taskId,
        '--container',
        'sandbox',
        '--interactive',
        '--command',
        command,
      ];
      try {
        const r = await execa(awsCli, args, {
          input: execOpts.stdin,
          timeout: execOpts.timeoutMs ?? 0,
          signal: execOpts.signal,
          reject: false,
        });
        return {
          exitCode: r.exitCode ?? 1,
          stdout: typeof r.stdout === 'string' ? r.stdout : '',
          stderr: typeof r.stderr === 'string' ? r.stderr : '',
          timedOut: Boolean((r as any).timedOut),
        };
      } catch (err) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: String((err as Error)?.message ?? err),
          timedOut: false,
        };
      }
    },

    async stopTask(taskArn, reason) {
      const cluster = extractClusterFromArn(taskArn);
      await ecs
        .send(
          new ecsModule.StopTaskCommand({
            cluster,
            task: taskArn,
            reason,
          }),
        )
        .catch(() => {});
    },
  };
}

function extractClusterFromArn(taskArn: string): string {
  // arn:aws:ecs:<region>:<acct>:task/<cluster>/<id>
  const parts = taskArn.split('/');
  return parts[1] ?? '';
}
