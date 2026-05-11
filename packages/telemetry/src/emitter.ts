import type { TelemetryEvent } from './events.js';
import { NoopTransport, type TelemetryTransport } from './transport.js';

export interface EmitterContext {
  /** Per-install random UUID. Null when telemetry is disabled. */
  installId: string | null;
  /** Whether the org has opted in. False short-circuits every emit. */
  enabled: boolean;
  /** Mergecrew version — read from the root package.json. */
  version: string;
}

/**
 * The single emit point for telemetry. Three guarantees:
 *
 *  1. `enabled === false` short-circuits before any payload is built
 *     — guarded paths can't accidentally hit the wire even on a
 *     misconfigured transport.
 *  2. The transport never throws. Every `send` is wrapped so a
 *     telemetry failure cannot fail the hot path that emitted it.
 *  3. The `installId` is the only identifier; the type system forbids
 *     adding any field per the `TelemetryEvent` union in events.ts.
 */
export class TelemetryEmitter {
  constructor(
    private readonly ctx: EmitterContext,
    private readonly transport: TelemetryTransport = new NoopTransport(),
  ) {}

  async emit(
    type: TelemetryEvent['type'],
    fields: Omit<Extract<TelemetryEvent, { type: typeof type }>, keyof EventBase>,
  ): Promise<void> {
    if (!this.ctx.enabled || !this.ctx.installId) return;
    const event = {
      type,
      installId: this.ctx.installId,
      occurredAt: new Date().toISOString(),
      version: this.ctx.version,
      ...fields,
    } as unknown as TelemetryEvent;
    try {
      await this.transport.send([event]);
    } catch {
      /* swallow — opt-in telemetry must never fail the hot path */
    }
  }
}

type EventBase = { type: string; installId: string; occurredAt: string; version: string };
