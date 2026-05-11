import { describe, expect, it } from 'vitest';
import { MemoryTransport, NoopTransport, TelemetryEmitter } from '../src/index.js';

const installId = '00000000-0000-0000-0000-000000000001';

describe('TelemetryEmitter — privacy invariants (#253)', () => {
  it('emits nothing when enabled === false', async () => {
    const t = new MemoryTransport();
    const e = new TelemetryEmitter({ installId, enabled: false, version: '0.1.0' }, t);
    await e.emit('org.created', {});
    await e.emit('project.created', { paused: true });
    expect(t.snapshot()).toEqual([]);
  });

  it('emits nothing when installId is null even if enabled is true', async () => {
    const t = new MemoryTransport();
    const e = new TelemetryEmitter({ installId: null, enabled: true, version: '0.1.0' }, t);
    await e.emit('run.completed', { status: 'done' });
    expect(t.snapshot()).toEqual([]);
  });

  it('stamps installId + occurredAt + version on every event', async () => {
    const t = new MemoryTransport();
    const e = new TelemetryEmitter({ installId, enabled: true, version: '0.1.0' }, t);
    await e.emit('project.created', { paused: false });
    const [ev] = t.snapshot();
    expect(ev?.installId).toBe(installId);
    expect(ev?.type).toBe('project.created');
    expect(ev?.version).toBe('0.1.0');
    expect(typeof ev?.occurredAt).toBe('string');
    expect(new Date(ev!.occurredAt).getTime()).toBeGreaterThan(0);
  });

  it('swallows transport errors so the hot path is never broken', async () => {
    const flaky = {
      async send(): Promise<void> {
        throw new Error('network down');
      },
    };
    const e = new TelemetryEmitter({ installId, enabled: true, version: '0.1.0' }, flaky);
    // Must not throw.
    await expect(e.emit('org.created', {})).resolves.toBeUndefined();
  });

  it('MemoryTransport bounds its buffer at the configured capacity', async () => {
    const t = new MemoryTransport(3);
    const e = new TelemetryEmitter({ installId, enabled: true, version: '0.1.0' }, t);
    for (let i = 0; i < 5; i++) {
      await e.emit('run.completed', { status: 'done' });
    }
    expect(t.snapshot()).toHaveLength(3);
  });

  it('NoopTransport.send resolves without recording', async () => {
    const t = new NoopTransport();
    await expect(t.send([])).resolves.toBeUndefined();
  });
});
