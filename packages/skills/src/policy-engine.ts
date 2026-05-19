/**
 * Per-agent-kind allowlists + signed call-tokens for high-impact skills
 * (#581 / #554 T-5).
 *
 * Two gates, layered:
 *
 *   1. **Per-agent-kind allowlist.** `AgentDefinition.skills` is the
 *      list of skill names this kind is allowed to call. The runtime
 *      already filters tools by this list before bindTools (#332); this
 *      gate hardens the *executor* so a future path that calls
 *      SkillExecutor.execute() outside the runtime (eg. an internal
 *      tool, an admin retry surface, a future cross-language bridge)
 *      can't bypass the allowlist.
 *
 *   2. **Signed call-tokens for high-impact skills.** Five skills
 *      (`repo.git.commit`, `repo.git.push`, `deploy.*`) need an HMAC
 *      signature proving the runner (which holds the key) authorized
 *      this call. Tokens are minted fresh per call with a stepId+nonce
 *      so they can't be replayed. The signing key is in the supervisor
 *      env (`SKILL_SIGNING_KEY`); the sandbox containers (#561 env
 *      scrub) never see it.
 *
 * The "what does the signature add?" question:
 *   - The LLM cannot mint a token because it cannot read the key.
 *   - The runtime *does* hold the key and signs before every dispatch,
 *     so legitimate calls just work. The signature is defense-in-depth
 *     for any future codepath that might wrap the executor without
 *     going through the runtime.
 *
 * Wired into SkillExecutor.execute via the optional `policy` field; if
 * absent, both gates are skipped (back-compat for tests + old callers).
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { ForbiddenError } from '@mergecrew/domain';

/**
 * Skills whose side effects are hard to reverse: a push, a deploy, a
 * production change. These require a signed call-token.
 *
 * To extend: add the skill name here AND ensure the runner signs the
 * call before dispatch. Keep this list small — every entry is a place
 * an operator may need to debug a "callToken missing" rejection.
 */
export const HIGH_IMPACT_SKILLS: ReadonlySet<string> = new Set([
  'repo.git.commit',
  'repo.git.push',
  'deploy.deploy_changeset',
  'deploy.run',
  'deploy.kick_workflow',
]);

export interface SignedCall {
  stepId: string;
  skill: string;
  nonce: string;
  /** ms-precision Unix epoch when this token was minted. */
  issuedAt: number;
}

/**
 * Policy engine signing surface. Methods are synchronous on purpose —
 * the call sites are hot (every skill dispatch), and HMAC is cheap.
 */
export interface PolicyEngine {
  /**
   * Is `skill` callable by an agent with allowlist `allowed`?
   * `allowed` is the `AgentDefinition.skills` list; an empty list
   * means "no skills allowed for this kind".
   */
  isAllowed(skill: string, allowed: readonly string[]): boolean;

  /**
   * Mint a signed call-token. Only the runner / supervisor should call
   * this — it requires the signing key. The returned string carries
   * everything `verifyCallToken` needs, so the caller doesn't store
   * state.
   */
  mintCallToken(call: { stepId: string; skill: string }): string;

  /**
   * Verify a token. Returns true on a fresh, well-formed, key-matching
   * token; false on anything else. Tokens older than the configured
   * TTL (default 5 minutes) are rejected so a stolen token can't be
   * replayed days later.
   */
  verifyCallToken(token: string, call: { stepId: string; skill: string }): boolean;
}

export interface PolicyEngineOpts {
  /**
   * HMAC key. Must be at least 32 bytes of entropy. Provided via
   * `SKILL_SIGNING_KEY` in the supervisor env; never present in the
   * sandbox env (#561 env scrub).
   */
  signingKey: Buffer | string;
  /**
   * Token TTL in milliseconds. Default 5 minutes — long enough that a
   * step that pauses on an LLM call doesn't have its tokens expire
   * mid-dispatch, short enough that a leaked token doesn't replay
   * weeks later.
   */
  tokenTtlMs?: number;
}

export class HmacPolicyEngine implements PolicyEngine {
  private readonly key: Buffer;
  private readonly tokenTtlMs: number;

  constructor(opts: PolicyEngineOpts) {
    const key = typeof opts.signingKey === 'string' ? Buffer.from(opts.signingKey, 'utf8') : opts.signingKey;
    if (key.length < 32) {
      throw new Error(
        `policy engine signing key must be at least 32 bytes; got ${key.length}`,
      );
    }
    this.key = key;
    this.tokenTtlMs = opts.tokenTtlMs ?? 5 * 60_000;
  }

  isAllowed(skill: string, allowed: readonly string[]): boolean {
    // `allowed === undefined` is handled by the executor (no allowlist =
    // back-compat unrestricted). Here we treat an empty array as
    // "explicitly nothing allowed" — matches AgentDefinition.skills=[].
    return allowed.includes(skill);
  }

  mintCallToken(call: { stepId: string; skill: string }): string {
    const payload: SignedCall = {
      stepId: call.stepId,
      skill: call.skill,
      nonce: randomBytes(12).toString('base64url'),
      issuedAt: Date.now(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verifyCallToken(token: string, call: { stepId: string; skill: string }): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [body, sig] = parts as [string, string];
    let expected: Buffer;
    let provided: Buffer;
    try {
      expected = createHmac('sha256', this.key).update(body).digest();
      provided = Buffer.from(sig, 'base64url');
    } catch {
      return false;
    }
    if (expected.length !== provided.length) return false;
    if (!timingSafeEqual(expected, provided)) return false;
    let payload: SignedCall;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (payload.stepId !== call.stepId) return false;
    if (payload.skill !== call.skill) return false;
    if (typeof payload.issuedAt !== 'number') return false;
    if (Date.now() - payload.issuedAt > this.tokenTtlMs) return false;
    return true;
  }
}

/**
 * Convenience: build a policy engine from `process.env.SKILL_SIGNING_KEY`.
 * Returns `null` when the env var is unset — the supervisor logs a
 * warning and skips signing in that case, which is fine for the V0
 * `process` driver where the LLM has no path to the executor anyway.
 * Production deployments set the key in their secrets store.
 */
export function buildPolicyEngineFromEnv(env: NodeJS.ProcessEnv = process.env): HmacPolicyEngine | null {
  const raw = env.SKILL_SIGNING_KEY;
  if (!raw || raw.length === 0) return null;
  return new HmacPolicyEngine({ signingKey: raw });
}

/**
 * Error thrown when an agent calls a skill it's not allowed to, or
 * when a high-impact skill lacks a valid call-token. Surfaces to the
 * timeline as `tool_call.error: skill_not_authorized` so operators
 * can debug — the runtime catches and re-raises with the agent kind.
 */
export class SkillNotAuthorizedError extends ForbiddenError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'SkillNotAuthorizedError';
  }
}
