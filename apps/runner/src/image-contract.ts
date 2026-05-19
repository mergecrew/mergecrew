import type { Logger } from 'pino';
import type { SandboxDriver, SandboxHandle } from '@mergecrew/sandbox-driver';

/**
 * BYO image contract validator (#571).
 *
 * When a project pins `runner.image` to a non-mergecrew image, the
 * supervisor probes it once on first use to confirm the contract
 * documented in `docs/03-infrastructure/22-runner-images.md`:
 *
 *   - default user is uid 1001
 *   - `/workspace` is writable
 *   - `bash`, `git`, `tini` are on PATH
 *
 * Violations are returned as a structured list so the runner can fail
 * the step with `config_invalid` and surface a precise message to the
 * operator rather than the agent staring at EACCES inside a build
 * skill 10 minutes later.
 *
 * The probe runs inside an existing sandbox handle (i.e. the driver
 * has already started the container with this image) — that keeps the
 * implementation simple and lets the same code run under either the
 * process driver (no-op trivial-pass) or the docker driver.
 */

export interface ImageContractViolation {
  property: string;
  expected: string;
  actual: string;
}

export interface ImageContractResult {
  ok: boolean;
  violations: ImageContractViolation[];
}

export interface ValidateImageContractArgs {
  driver: SandboxDriver;
  sandbox: SandboxHandle;
  logger?: Logger;
  abortSignal?: AbortSignal;
}

const REQUIRED_BINARIES = ['bash', 'git', 'tini'];

export async function validateImageContract(
  args: ValidateImageContractArgs,
): Promise<ImageContractResult> {
  const { driver, sandbox, abortSignal } = args;
  const violations: ImageContractViolation[] = [];

  // ProcessDriver runs as the supervisor's uid; the contract is
  // structurally inapplicable. Treat as pass — the runner already
  // warned about unsandboxed mode at startup (#563).
  if (driver.name === 'process') {
    return { ok: true, violations: [] };
  }

  // uid check.
  const uidRes = await driver.exec(sandbox, { cmd: 'id', args: ['-u'], signal: abortSignal });
  const uid = uidRes.stdout.trim();
  if (uidRes.exitCode !== 0 || uid !== '1001') {
    violations.push({
      property: 'default_user_uid',
      expected: '1001',
      actual: uidRes.exitCode === 0 ? uid : `id -u exit=${uidRes.exitCode}`,
    });
  }

  // /workspace writable check.
  const writeRes = await driver.exec(sandbox, {
    cmd: 'sh',
    args: ['-c', 'touch /workspace/.mergecrew-contract-probe && rm -f /workspace/.mergecrew-contract-probe'],
    signal: abortSignal,
  });
  if (writeRes.exitCode !== 0) {
    violations.push({
      property: '/workspace_writable',
      expected: 'writable by sandbox user',
      actual: `touch exit=${writeRes.exitCode} stderr=${writeRes.stderr.slice(0, 200)}`,
    });
  }

  // Required binaries.
  for (const bin of REQUIRED_BINARIES) {
    const r = await driver.exec(sandbox, {
      cmd: 'sh',
      args: ['-c', `command -v ${bin} >/dev/null 2>&1`],
      signal: abortSignal,
    });
    if (r.exitCode !== 0) {
      violations.push({
        property: `binary:${bin}`,
        expected: 'on PATH',
        actual: 'not found',
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** One-line human summary of the violations, suitable for an event payload. */
export function summarizeViolations(violations: ImageContractViolation[]): string {
  if (violations.length === 0) return 'ok';
  return violations.map((v) => `${v.property}: expected ${v.expected}, got ${v.actual}`).join('; ');
}
