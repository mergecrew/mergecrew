import { createHash, randomBytes } from 'node:crypto';
import { withSystem } from '@mergecrew/db';

/**
 * Shared helper for per-step ephemeral RunnerAgent token minting
 * (V2.ag / ADR-0004). Used by both the Fargate-BYO launcher (#786)
 * and the GitHub-Actions launcher (#772) — both dispatch a fresh,
 * single-use agent token into a transient compute environment
 * (ECS task or GHA runner). The deployment writes only the
 * sha256 hash to `runner_agents`; the plaintext is returned exactly
 * once to the caller.
 *
 * Token shape: `mca_<orgSlug>_<26 base32 chars>` — same as
 * user-enrolled agents per ADR-0004.
 */

const TOKEN_PREFIX = 'mca_';
const TOKEN_SECRET_LENGTH = 26;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface MintArgs {
  organizationId: string;
  organizationSlug: string;
  /** Used in the per-step name to make the agents settings list scannable. */
  stepId: string;
  /** Display name prefix — e.g. 'fargate' or 'github-actions'. */
  source: string;
}

export interface MintedAgent {
  /** Plaintext bearer. Show once, never log. */
  token: string;
  /** RunnerAgent row id. Caller can revoke via the existing API. */
  agentId: string;
}

export async function mintEphemeralAgent(args: MintArgs): Promise<MintedAgent> {
  const buf = randomBytes(TOKEN_SECRET_LENGTH);
  const secret = Array.from(buf, (b) => BASE32[b & 0x1f]!).join('');
  const token = `${TOKEN_PREFIX}${args.organizationSlug}_${secret}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, `${TOKEN_PREFIX}${args.organizationSlug}_`.length + 6);

  const row = await withSystem((tx) =>
    tx.runnerAgent.create({
      data: {
        organizationId: args.organizationId,
        name: `${args.source}-step-${args.stepId}`,
        tokenHash,
        prefix,
      },
    }),
  );
  return { token, agentId: row.id };
}
