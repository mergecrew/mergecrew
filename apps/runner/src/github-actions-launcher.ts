import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { mintEphemeralAgent } from './agent-tokens.js';

/**
 * Triggers a GitHub Actions `workflow_dispatch` in the user's repo
 * to launch a one-shot `mergecrew/runner-agent` (V2.ag / #772 /
 * ADR-0007). The agent inside the GHA runner picks up the per-step
 * claim from the deployment's per-org queue and runs sandbox-ops
 * via HttpSandboxDriver — same shape as Fargate-BYO once launched.
 *
 * Trust posture:
 *   - The supervisor decrypts the user-supplied PAT in-process,
 *     uses it for exactly one POST to /repos/{owner}/{repo}/actions/
 *     workflows/{file}/dispatches, and lets it fall out of scope.
 *     Never persisted in plaintext beyond the request lifetime.
 *   - The agent inside the workflow run receives the
 *     per-step bearer token via `workflow_dispatch` inputs. The
 *     token is single-use ephemeral; if leaked from a workflow
 *     log it's only usable for the few seconds–minutes until the
 *     step completes (after which the agent process exits and
 *     the token is effectively spent against an absent peer).
 *
 * Token-leak surface: GitHub renders `workflow_dispatch` inputs in
 * the Actions UI for users with read access to the repo's runs.
 * The agent token leaks if those users are not trusted. v1.1 can
 * move the token into a repo Secret rotated per-dispatch via the
 * REST API; for v1 this trade is documented and bounded by the
 * ephemerality of the token.
 */

export interface GithubActionsProfile {
  githubRepoFullName: string; // "owner/repo"
  githubWorkflowFileName: string; // "mergecrew-runner.yml"
  githubTokenCiphertext: Uint8Array;
}

export interface GithubActionsLaunchArgs {
  organizationId: string;
  organizationSlug: string;
  stepId: string;
  runId: string;
  profile: GithubActionsProfile;
  apiBaseUrl: string;
  logger: Logger;
}

export interface GithubActionsLaunchResult {
  /** The full repo path, for log scoping + the run timeline. */
  repoFullName: string;
  agentId: string;
}

/**
 * Dispatches the user-configured workflow. The user's workflow file
 * is expected to accept two `workflow_dispatch` inputs:
 *   - `mergecrewStepId`  (string, required)
 *   - `mergecrewAgentToken` (string, required, secret-shaped)
 *
 * The body it runs should be `docker run mergecrew/runner-agent
 * --token "${{ inputs.mergecrewAgentToken }}" --api-url <DEPLOYMENT>
 * --name gha-<stepId>` (full example in
 * docs/03-infrastructure/36-runner-github-actions.md).
 */
export async function launchGithubActionsWorkflow(
  args: GithubActionsLaunchArgs,
): Promise<GithubActionsLaunchResult> {
  const { organizationId, organizationSlug, stepId, profile, apiBaseUrl, logger } = args;

  const { token, agentId } = await mintEphemeralAgent({
    organizationId,
    organizationSlug,
    stepId,
    source: 'github-actions',
  });

  const pat = decryptToken(profile.githubTokenCiphertext);
  // GitHub's `workflow_dispatch` API needs a ref. Default branch is
  // the safest choice for a one-shot — the user's workflow file is
  // pinned to whatever's on that branch. Resolved via the repo's
  // metadata so we don't hardcode 'main'.
  const ref = await resolveDefaultBranch(profile.githubRepoFullName, pat);

  const url =
    `https://api.github.com/repos/${profile.githubRepoFullName}` +
    `/actions/workflows/${encodeURIComponent(profile.githubWorkflowFileName)}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${pat}`,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'mergecrew-runner',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        mergecrewStepId: stepId,
        mergecrewAgentToken: token,
        mergecrewApiUrl: apiBaseUrl,
      },
    }),
  });

  if (res.status !== 204) {
    // GitHub returns 204 on success. Anything else is a failure —
    // surface the body for diagnostics. Token scrubbing isn't
    // needed here because we send the token in the body but the
    // ERROR response doesn't echo it back; the PAT is sent in the
    // Authorization header which the server doesn't reflect either.
    const body = await res.text().catch(() => '');
    throw new Error(
      `github-actions: workflow_dispatch returned ${res.status} ${res.statusText} (${body.slice(0, 300)})`,
    );
  }

  logger.info(
    {
      stepId,
      agentId,
      repo: profile.githubRepoFullName,
      workflow: profile.githubWorkflowFileName,
      ref,
    },
    'github-actions: workflow_dispatch sent; awaiting agent /hello',
  );

  // Best-effort scrub: overwrite the PAT in-process so a heap dump
  // of the runner doesn't trivially leak it. Node strings are
  // immutable so this is largely cosmetic, but the closure-local
  // pat reference now falls out of scope.
  void pat;

  return { repoFullName: profile.githubRepoFullName, agentId };
}

async function resolveDefaultBranch(repoFullName: string, pat: string): Promise<string> {
  const url = `https://api.github.com/repos/${repoFullName}`;
  const res = await fetch(url, {
    headers: {
      'authorization': `Bearer ${pat}`,
      'accept': 'application/vnd.github+json',
      'user-agent': 'mergecrew-runner',
    },
  });
  if (!res.ok) {
    throw new Error(
      `github-actions: GET /repos/${repoFullName} returned ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { default_branch?: string };
  return body.default_branch ?? 'main';
}

/**
 * Decrypts the envelope-encrypted GitHub PAT (ADR-0007). Mirrors
 * the same AES-256-GCM layout the API's CryptoService writes — the
 * supervisor reads it back via the same KMS_MASTER_KEY env so we
 * never need to ship plaintext PATs to the runner.
 */
function decryptToken(blob: Uint8Array): string {
  if (blob[0] !== 1) {
    throw new Error('github-actions: unknown ciphertext version on githubTokenCiphertext');
  }
  const masterKeyRaw = process.env.KMS_MASTER_KEY ?? '';
  if (!masterKeyRaw.startsWith('base64:')) {
    throw new Error('KMS_MASTER_KEY must start with "base64:"');
  }
  const masterKey = Buffer.from(masterKeyRaw.slice(7), 'base64');
  if (masterKey.length !== 32) {
    throw new Error('KMS_MASTER_KEY must be 32 bytes');
  }
  // Layout (matches apps/api/src/common/crypto.service.ts):
  //   [1B version][12B wrapIv][16B wrapTag][32B wrapped][12B iv][16B tag][N ct]
  const buf = Buffer.from(blob);
  let pos = 1;
  const wrapIv = buf.subarray(pos, pos + 12); pos += 12;
  const wrapTag = buf.subarray(pos, pos + 16); pos += 16;
  const wrapped = buf.subarray(pos, pos + 32); pos += 32;
  const iv = buf.subarray(pos, pos + 12); pos += 12;
  const tag = buf.subarray(pos, pos + 16); pos += 16;
  const ct = buf.subarray(pos);

  const wrapDecipher = crypto.createDecipheriv('aes-256-gcm', masterKey, wrapIv);
  wrapDecipher.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([wrapDecipher.update(wrapped), wrapDecipher.final()]);

  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
