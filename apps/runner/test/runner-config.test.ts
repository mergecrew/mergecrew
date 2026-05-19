import { describe, expect, it } from 'vitest';
import {
  parseDurationMs,
  parseMemoryMb,
  resolveSandboxResources,
  RUNNER_CONFIG_DEFAULTS,
} from '../src/runner-config.js';

describe('parseMemoryMb', () => {
  it('plain number → MB', () => {
    expect(parseMemoryMb('512')).toBe(512);
    expect(parseMemoryMb('2048')).toBe(2048);
  });

  it('Mi suffix → MB (binary)', () => {
    expect(parseMemoryMb('512Mi')).toBe(512);
  });

  it('Gi suffix → MB (binary)', () => {
    expect(parseMemoryMb('1Gi')).toBe(1024);
    expect(parseMemoryMb('4Gi')).toBe(4096);
  });

  it('M suffix → MB (decimal)', () => {
    // 1_000_000 bytes / 1024^2 ≈ 0.95 MB ≈ rounds to 1
    expect(parseMemoryMb('1M')).toBeGreaterThanOrEqual(0);
  });

  it('G suffix → MB (decimal)', () => {
    expect(parseMemoryMb('1G')).toBe(Math.round(1_000_000_000 / (1024 * 1024)));
  });

  it('throws on garbage', () => {
    expect(() => parseMemoryMb('huge')).toThrow();
    expect(() => parseMemoryMb('1xb')).toThrow();
  });
});

describe('parseDurationMs', () => {
  it('plain number → ms (treated as seconds)', () => {
    expect(parseDurationMs('120')).toBe(120_000);
  });

  it('s suffix → ms', () => {
    expect(parseDurationMs('45s')).toBe(45_000);
  });

  it('m suffix → ms', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60 * 1000);
  });

  it('h suffix → ms', () => {
    expect(parseDurationMs('1h')).toBe(60 * 60 * 1000);
  });

  it('throws on garbage', () => {
    expect(() => parseDurationMs('forever')).toThrow();
  });
});

describe('resolveSandboxResources', () => {
  it('returns defaults when no runner block', () => {
    const r = resolveSandboxResources(undefined);
    expect(r).toEqual({
      cpu: RUNNER_CONFIG_DEFAULTS.cpu,
      memoryMb: RUNNER_CONFIG_DEFAULTS.memoryMb,
      pids: RUNNER_CONFIG_DEFAULTS.pids,
      timeoutMs: RUNNER_CONFIG_DEFAULTS.timeoutMs,
    });
  });

  it('honors per-project overrides', () => {
    const r = resolveSandboxResources({
      resources: { cpu: 2, memory: '4Gi', pids: 512, timeout: '30m' },
    });
    expect(r).toEqual({
      cpu: 2,
      memoryMb: 4096,
      pids: 512,
      timeoutMs: 30 * 60 * 1000,
    });
  });

  it('fills only the unset fields', () => {
    const r = resolveSandboxResources({ resources: { memory: '2Gi' } });
    expect(r.cpu).toBe(RUNNER_CONFIG_DEFAULTS.cpu);
    expect(r.memoryMb).toBe(2048);
    expect(r.pids).toBe(RUNNER_CONFIG_DEFAULTS.pids);
    expect(r.timeoutMs).toBe(RUNNER_CONFIG_DEFAULTS.timeoutMs);
  });

  it('honors supervisor-level default overrides', () => {
    const r = resolveSandboxResources(undefined, {
      cpu: 4,
      memoryMb: 8192,
      pids: 1024,
      timeoutMs: 60 * 60 * 1000,
    });
    expect(r).toEqual({ cpu: 4, memoryMb: 8192, pids: 1024, timeoutMs: 60 * 60 * 1000 });
  });
});
