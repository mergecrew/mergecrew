import type { TelemetryEvent } from './events.js';
import type { TelemetryTransport } from './transport.js';

export interface HttpTransportOptions {
  url: string;
  /**
   * Per-request abort threshold. Telemetry must never slow the hot
   * path — bail out at the timeout and drop the events. Default 2s.
   */
  timeoutMs?: number;
}

/**
 * Fire-and-forget HTTP transport. POSTs a JSON array of events. Any
 * non-2xx response or network error is swallowed — telemetry is
 * best-effort and must not affect the surrounding request.
 *
 * No retries, no buffering, no backpressure. Operators wanting
 * guaranteed delivery should run their own receiver and put a queue
 * between the receiver and storage; this transport's job stops at
 * "hand the events off."
 */
export class HttpTransport implements TelemetryTransport {
  constructor(private readonly opts: HttpTransportOptions) {}

  async send(batch: TelemetryEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 2_000);
    try {
      await fetch(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: controller.signal,
      }).catch(() => {
        /* swallow */
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
