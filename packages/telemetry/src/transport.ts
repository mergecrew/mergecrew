import type { TelemetryEvent } from './events.js';

/**
 * Pluggable transport for telemetry events. Each call gets a single
 * batch; failures are swallowed (telemetry is opt-in and must never
 * fail the hot path). PR 1 (#253) ships only the `MemoryTransport`
 * stub — a real HTTP transport lands in the follow-up once the
 * receiving backend is chosen (Cloudflare Worker / Plausible /
 * self-hosted endpoint).
 */
export interface TelemetryTransport {
  send(batch: TelemetryEvent[]): Promise<void>;
}

/**
 * In-memory transport: records every event the emitter would have
 * sent. Used in two places:
 *
 *  1. The Settings → Telemetry audit panel in the web UI — operators
 *     see exactly what the emitter buffered locally, so they can
 *     audit before pointing at a real endpoint.
 *  2. Unit tests, where the events are asserted directly.
 *
 * Bounded buffer (default 100) so a long-running process doesn't
 * grow unbounded if telemetry stays enabled but no real transport
 * is wired up.
 */
export class MemoryTransport implements TelemetryTransport {
  private buf: TelemetryEvent[] = [];
  constructor(private readonly capacity: number = 100) {}

  async send(batch: TelemetryEvent[]): Promise<void> {
    this.buf.push(...batch);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  /** Read-only view of buffered events for the audit panel. */
  snapshot(): TelemetryEvent[] {
    return [...this.buf];
  }

  /** Drop everything — only used by tests. */
  clear(): void {
    this.buf.length = 0;
  }
}

/**
 * No-op transport. Used when telemetry is disabled on the org so
 * accidental `.emit()` calls flow through to a transport that
 * cannot, by construction, leak data.
 */
export class NoopTransport implements TelemetryTransport {
  async send(_batch: TelemetryEvent[]): Promise<void> {
    /* intentionally empty */
  }
}
