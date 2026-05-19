import type { RunnerConfig, RunnerResources } from '@mergecrew/domain';
import type { SandboxResources } from '@mergecrew/sandbox-driver';

/**
 * Defaults applied when `mergecrew.yaml` doesn't pin a value. Kept here
 * (rather than in the zod schema's `.default(...)`) so they remain
 * adjustable per supervisor deploy via env without forcing every project
 * to re-emit its yaml.
 */
export interface RunnerConfigDefaults {
  cpu: number;
  memoryMb: number;
  pids: number;
  timeoutMs: number;
}

export const RUNNER_CONFIG_DEFAULTS: RunnerConfigDefaults = {
  cpu: 1,
  memoryMb: 1024,
  pids: 256,
  timeoutMs: 20 * 60 * 1000,
};

/**
 * Translate the project's `runner:` yaml block into the numeric shape
 * the SandboxDriver consumes. Missing fields fall back to
 * `RUNNER_CONFIG_DEFAULTS`. Pure function — no I/O — so the parsing is
 * unit-testable without spinning a runner.
 */
export function resolveSandboxResources(
  runnerCfg: RunnerConfig | undefined,
  defaults: RunnerConfigDefaults = RUNNER_CONFIG_DEFAULTS,
): SandboxResources {
  const r: RunnerResources = runnerCfg?.resources ?? {};
  return {
    cpu: r.cpu ?? defaults.cpu,
    memoryMb: r.memory != null ? parseMemoryMb(r.memory) : defaults.memoryMb,
    pids: r.pids ?? defaults.pids,
    timeoutMs: r.timeout != null ? parseDurationMs(r.timeout) : defaults.timeoutMs,
  };
}

/**
 * `"512Mi"` → 512, `"1Gi"` → 1024, `"4G"` → 4000, `"2048"` → 2048.
 * Tolerates the formats k8s users already know. Throws on a value the
 * zod schema would normally reject — `resolveSandboxResources` is the
 * second line of defense.
 */
export function parseMemoryMb(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(Mi|Gi|G|M)?$/);
  if (!m) throw new Error(`invalid memory value: ${value}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case 'Mi':
      return Math.round(n);
    case 'M':
      return Math.round((n * 1_000_000) / (1024 * 1024));
    case 'Gi':
      return Math.round(n * 1024);
    case 'G':
      return Math.round((n * 1_000_000_000) / (1024 * 1024));
    default:
      throw new Error(`invalid memory unit: ${m[2]}`);
  }
}

/** `"30m"` → 1_800_000, `"1h"` → 3_600_000, `"45s"` → 45_000, `"120"` → 120_000. */
export function parseDurationMs(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h)?$/);
  if (!m) throw new Error(`invalid duration value: ${value}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case 's':
      return Math.round(n * 1000);
    case 'm':
      return Math.round(n * 60 * 1000);
    case 'h':
      return Math.round(n * 60 * 60 * 1000);
    default:
      throw new Error(`invalid duration unit: ${m[2]}`);
  }
}
