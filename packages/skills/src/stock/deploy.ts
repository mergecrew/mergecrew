import { ValidationError } from '@mergecrew/domain';
import type { AnySkill } from '../types.js';

interface DeployTargetConfig {
  targetId: string;
  ref: string;
  branch: string;
  correlationId: string;
}

const deployDevSkill: AnySkill = {
  name: 'deploy.dev',
  description: 'Trigger a deploy to the dev target for the current changeset.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      branch: { type: 'string' },
    },
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['deploy.trigger', 'net.outbound'],
  timeoutMs: 1_800_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.deploy) throw new ValidationError('deploy.dev: deploy adapter required');
    const cfg = (ctx.config?.devTarget ?? {}) as Partial<DeployTargetConfig>;
    if (!cfg.targetId) throw new ValidationError('deploy.dev: devTarget.targetId required');
    const ref = input.ref ?? cfg.ref;
    const branch = input.branch ?? cfg.branch;
    const correlationId = cfg.correlationId ?? crypto.randomUUID();
    const handle = await ctx.adapters.deploy.triggerDeploy(
      { id: cfg.targetId, kind: 'dev', adapterId: ctx.adapters.deploy.id, config: (ctx.config?.adapterConfig ?? {}) as Record<string, unknown> },
      { ref, branch, correlationId },
    );
    const result = await ctx.adapters.deploy.awaitCompletion(handle, 1_500_000, ctx.abortSignal);
    return {
      output: { handle, status: result.status, url: result.url },
      brief: `dev deploy ${result.status.kind}${result.url ? ` ${result.url}` : ''}`,
    };
  },
};

const deployProdSkill: AnySkill = {
  name: 'deploy.prod',
  description: 'Trigger a deploy to the production target. Only callable by the orchestrator after a Promote decision.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
    },
    required: ['ref'],
    additionalProperties: false,
  },
  sideEffectClass: 'irreversible',
  capabilities: ['deploy.trigger', 'net.outbound'],
  timeoutMs: 1_800_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.deploy) throw new ValidationError('deploy.prod: deploy adapter required');
    const cfg = (ctx.config?.prodTarget ?? {}) as Partial<DeployTargetConfig>;
    if (!cfg.targetId) throw new ValidationError('deploy.prod: prodTarget.targetId required');
    const correlationId = cfg.correlationId ?? crypto.randomUUID();
    const handle = await ctx.adapters.deploy.triggerDeploy(
      { id: cfg.targetId, kind: 'prod', adapterId: ctx.adapters.deploy.id, config: (ctx.config?.adapterConfig ?? {}) as Record<string, unknown> },
      { ref: input.ref, branch: cfg.branch ?? 'main', correlationId },
    );
    const result = await ctx.adapters.deploy.awaitCompletion(handle, 1_700_000, ctx.abortSignal);
    return {
      output: { handle, status: result.status, url: result.url },
      brief: `prod deploy ${result.status.kind}`,
    };
  },
};

const deployStatusSkill: AnySkill = {
  name: 'deploy.status',
  description: 'Get current status of a deploy by handle.',
  inputSchema: {
    type: 'object',
    properties: {
      externalRunId: { type: 'string' },
      targetId: { type: 'string' },
    },
    required: ['externalRunId', 'targetId'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['deploy.read', 'net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.deploy) throw new ValidationError('deploy.status: deploy adapter required');
    const status = await ctx.adapters.deploy.getStatus({
      externalRunId: input.externalRunId,
      targetId: input.targetId,
      correlationId: '',
    });
    return { output: status, brief: `status: ${status.kind}` };
  },
};

const deployLogsSkill: AnySkill = {
  name: 'deploy.logs',
  description: 'Fetch a snippet of logs for a deploy.',
  inputSchema: {
    type: 'object',
    properties: {
      externalRunId: { type: 'string' },
      targetId: { type: 'string' },
      tailLines: { type: 'integer' },
    },
    required: ['externalRunId', 'targetId'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['deploy.read', 'net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.deploy) throw new ValidationError('deploy.logs: deploy adapter required');
    const logs = await ctx.adapters.deploy.fetchLogs(
      { externalRunId: input.externalRunId, targetId: input.targetId, correlationId: '' },
      { tailLines: input.tailLines ?? 100 },
    );
    return { output: { logs }, brief: `${logs.length} chunks` };
  },
};

const deployUrlForBranchSkill: AnySkill = {
  name: 'deploy.url_for_branch',
  description: 'Resolve the dev URL for a given branch.',
  inputSchema: {
    type: 'object',
    properties: { branch: { type: 'string' }, targetId: { type: 'string' } },
    required: ['branch', 'targetId'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['deploy.read', 'net.outbound'],
  async execute(input: any, ctx) {
    if (!ctx.adapters.deploy) throw new ValidationError('deploy.url_for_branch: deploy adapter required');
    const url = await ctx.adapters.deploy.resolveUrlForRef(
      { id: input.targetId, kind: 'dev', adapterId: ctx.adapters.deploy.id, config: (ctx.config?.adapterConfig ?? {}) as Record<string, unknown> },
      input.branch,
    );
    return { output: { url }, brief: url ?? 'no URL' };
  },
};

export const deploySkills: AnySkill[] = [
  deployDevSkill,
  deployProdSkill,
  deployStatusSkill,
  deployLogsSkill,
  deployUrlForBranchSkill,
];
