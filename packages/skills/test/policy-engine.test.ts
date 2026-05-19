import { describe, expect, it, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  HIGH_IMPACT_SKILLS,
  HmacPolicyEngine,
  SkillExecutor,
  SkillNotAuthorizedError,
  buildPolicyEngineFromEnv,
  type AnySkill,
  type SkillExecutionContext,
} from '../src/index.js';

const KEY = randomBytes(32);

function buildCtx(over: Partial<SkillExecutionContext> = {}): SkillExecutionContext {
  return {
    organizationId: 'org',
    projectId: 'proj',
    abortSignal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    adapters: {},
    ...over,
  };
}

const echoSkill: AnySkill = {
  name: 'repo.read_file',
  description: 'noop',
  inputSchema: {},
  sideEffectClass: 'read',
  capabilities: [],
  async execute() {
    return { output: 'ok', brief: 'ok' };
  },
};

const commitSkill: AnySkill = {
  name: 'repo.git.commit',
  description: 'noop',
  inputSchema: {},
  sideEffectClass: 'write_workspace',
  capabilities: [],
  async execute() {
    return { output: 'ok', brief: 'committed' };
  },
};

describe('HmacPolicyEngine', () => {
  it('rejects too-short keys', () => {
    expect(() => new HmacPolicyEngine({ signingKey: 'short' })).toThrow(/at least 32 bytes/);
  });

  it('isAllowed checks the per-agent allowlist as exact match', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY });
    expect(p.isAllowed('repo.read_file', ['repo.read_file', 'repo.list_paths'])).toBe(true);
    expect(p.isAllowed('repo.git.commit', ['repo.read_file', 'repo.list_paths'])).toBe(false);
    // Empty allowlist = nothing allowed.
    expect(p.isAllowed('repo.read_file', [])).toBe(false);
  });

  it('round-trips a call-token for the same stepId + skill', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY });
    const token = p.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    expect(p.verifyCallToken(token, { stepId: 'step-1', skill: 'repo.git.commit' })).toBe(true);
  });

  it('rejects a token used for a different stepId', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY });
    const token = p.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    expect(p.verifyCallToken(token, { stepId: 'step-2', skill: 'repo.git.commit' })).toBe(false);
  });

  it('rejects a token used for a different skill (no cross-skill replay)', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY });
    const token = p.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    expect(p.verifyCallToken(token, { stepId: 'step-1', skill: 'deploy.run' })).toBe(false);
  });

  it('rejects a forged token signed with the wrong key', () => {
    const real = new HmacPolicyEngine({ signingKey: KEY });
    const evil = new HmacPolicyEngine({ signingKey: randomBytes(32) });
    const forged = evil.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    expect(real.verifyCallToken(forged, { stepId: 'step-1', skill: 'repo.git.commit' })).toBe(false);
  });

  it('rejects expired tokens (older than ttl)', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY, tokenTtlMs: 100 });
    const token = p.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    // Fast-forward by stubbing Date.now.
    const orig = Date.now;
    Date.now = () => orig() + 200;
    try {
      expect(p.verifyCallToken(token, { stepId: 'step-1', skill: 'repo.git.commit' })).toBe(false);
    } finally {
      Date.now = orig;
    }
  });

  it('rejects malformed tokens', () => {
    const p = new HmacPolicyEngine({ signingKey: KEY });
    expect(p.verifyCallToken('not-a-token', { stepId: 's', skill: 'x' })).toBe(false);
    expect(p.verifyCallToken('a.b.c', { stepId: 's', skill: 'x' })).toBe(false);
    expect(p.verifyCallToken('', { stepId: 's', skill: 'x' })).toBe(false);
  });
});

describe('buildPolicyEngineFromEnv', () => {
  it('returns null when env is unset', () => {
    expect(buildPolicyEngineFromEnv({})).toBeNull();
  });

  it('builds an engine when SKILL_SIGNING_KEY is set', () => {
    const key = randomBytes(32).toString('hex'); // 64 bytes when treated as utf8
    const engine = buildPolicyEngineFromEnv({ SKILL_SIGNING_KEY: key } as any);
    expect(engine).not.toBeNull();
  });
});

describe('SkillExecutor with policy engine', () => {
  let executor: SkillExecutor;
  let policy: HmacPolicyEngine;

  beforeEach(() => {
    policy = new HmacPolicyEngine({ signingKey: KEY });
    executor = new SkillExecutor({ policy });
    executor.register(echoSkill);
    executor.register(commitSkill);
  });

  it('rejects a skill not in the agent allowlist', async () => {
    await expect(
      executor.execute('repo.read_file', {}, buildCtx({
        agentKind: 'Reviewer',
        allowedSkills: ['repo.list_paths'],
        agentStepId: 'step-1',
      })),
    ).rejects.toBeInstanceOf(SkillNotAuthorizedError);
  });

  it('allows a skill that IS in the agent allowlist', async () => {
    const r = await executor.execute('repo.read_file', {}, buildCtx({
      agentKind: 'Coder',
      allowedSkills: ['repo.read_file'],
      agentStepId: 'step-1',
    }));
    expect(r.brief).toBe('ok');
  });

  it('skips the allowlist gate when allowedSkills is undefined (back-compat)', async () => {
    const r = await executor.execute('repo.read_file', {}, buildCtx({ agentStepId: 'step-1' }));
    expect(r.brief).toBe('ok');
  });

  it('rejects a high-impact skill called without a call-token', async () => {
    await expect(
      executor.execute('repo.git.commit', {}, buildCtx({
        agentKind: 'Coder',
        allowedSkills: ['repo.git.commit'],
        agentStepId: 'step-1',
      })),
    ).rejects.toMatchObject({ details: { code: 'call_token_missing' } });
  });

  it('rejects a high-impact skill with an invalid call-token', async () => {
    await expect(
      executor.execute('repo.git.commit', {}, buildCtx({
        agentKind: 'Coder',
        allowedSkills: ['repo.git.commit'],
        agentStepId: 'step-1',
        callToken: 'forged.token',
      })),
    ).rejects.toMatchObject({ details: { code: 'call_token_invalid' } });
  });

  it('allows a high-impact skill with a fresh, valid call-token', async () => {
    const token = policy.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    const r = await executor.execute('repo.git.commit', {}, buildCtx({
      agentKind: 'Coder',
      allowedSkills: ['repo.git.commit'],
      agentStepId: 'step-1',
      callToken: token,
    }));
    expect(r.brief).toBe('committed');
  });

  it('does not enforce signing when no policy engine is configured (back-compat)', async () => {
    const open = new SkillExecutor();
    open.register(commitSkill);
    const r = await open.execute('repo.git.commit', {}, buildCtx({ agentStepId: 'step-1' }));
    expect(r.brief).toBe('committed');
  });

  it('rejects a stolen token across stepIds', async () => {
    const token = policy.mintCallToken({ stepId: 'step-1', skill: 'repo.git.commit' });
    await expect(
      executor.execute('repo.git.commit', {}, buildCtx({
        agentKind: 'Coder',
        allowedSkills: ['repo.git.commit'],
        agentStepId: 'step-2',
        callToken: token,
      })),
    ).rejects.toMatchObject({ details: { code: 'call_token_invalid' } });
  });
});

describe('HIGH_IMPACT_SKILLS list', () => {
  it('includes the git + deploy skills', () => {
    expect(HIGH_IMPACT_SKILLS.has('repo.git.commit')).toBe(true);
    expect(HIGH_IMPACT_SKILLS.has('repo.git.push')).toBe(true);
    expect(HIGH_IMPACT_SKILLS.has('deploy.deploy_changeset')).toBe(true);
    expect(HIGH_IMPACT_SKILLS.has('deploy.run')).toBe(true);
    expect(HIGH_IMPACT_SKILLS.has('deploy.kick_workflow')).toBe(true);
  });

  it('does NOT include read-only skills', () => {
    expect(HIGH_IMPACT_SKILLS.has('repo.read_file')).toBe(false);
    expect(HIGH_IMPACT_SKILLS.has('repo.list_paths')).toBe(false);
    expect(HIGH_IMPACT_SKILLS.has('web.fetch_url')).toBe(false);
  });
});
