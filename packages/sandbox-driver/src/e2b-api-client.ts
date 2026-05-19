/**
 * Real `e2b` SDK adapter for the E2BDriver (#579).
 *
 * Lazy-imports the SDK so non-microVM operators don't pay the install
 * cost. The seam (`E2BApiClient`) is stable; swap to a direct-Firecracker
 * implementation later without touching the driver.
 */

import type { E2BApiClient, E2BCreateOpts } from './e2b-driver.js';

export interface E2BClientOpts {
  /**
   * E2B control plane domain. Hosted: `https://api.e2b.dev`. Self-
   * hosted: the operator's own URL. Required.
   */
  domain: string;
  /**
   * API key. Optional for self-hosted clusters configured without
   * auth; required for hosted E2B.
   */
  apiKey?: string;
}

export async function buildE2BApiClient(opts: E2BClientOpts): Promise<E2BApiClient> {
  const e2b = await import('e2b');
  // The e2b SDK reads E2B_DOMAIN + E2B_API_KEY from env. Setting them
  // here keeps the supervisor's actual env clean (the supervisor may
  // talk to *multiple* E2B clusters if the operator self-hosts in
  // several regions).
  const env = {
    domain: opts.domain,
    apiKey: opts.apiKey,
  };
  return {
    async createSandbox(create: E2BCreateOpts): Promise<string> {
      const sandbox = await e2b.Sandbox.create(create.template, {
        ...env,
        metadata: create.metadata,
        envs: create.envs,
        timeoutMs: create.timeoutMs,
      } as any);
      return sandbox.sandboxId;
    },
    async runCommand(sandboxId, cmd, runOpts) {
      const sandbox = await e2b.Sandbox.connect(sandboxId, env as any);
      const r = await sandbox.commands.run(cmd.join(' '), {
        timeoutMs: runOpts.timeoutMs,
      } as any);
      return {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        timedOut: Boolean((r as any).timedOut),
      };
    },
    async readFile(sandboxId, path) {
      const sandbox = await e2b.Sandbox.connect(sandboxId, env as any);
      const content = await sandbox.files.read(path);
      return Buffer.from(typeof content === 'string' ? content : (content as any));
    },
    async writeFile(sandboxId, path, data) {
      const sandbox = await e2b.Sandbox.connect(sandboxId, env as any);
      await sandbox.files.write(path, data as any);
    },
    async killSandbox(sandboxId) {
      const sandbox = await e2b.Sandbox.connect(sandboxId, env as any).catch(() => null);
      await sandbox?.kill().catch(() => {});
    },
  };
}
