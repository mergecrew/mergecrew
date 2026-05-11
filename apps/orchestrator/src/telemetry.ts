import { withSystem } from '@mergecrew/db';
import {
  HttpTransport,
  NoopTransport,
  TelemetryEmitter,
  type TelemetryEvent,
  type TelemetryTransport,
} from '@mergecrew/telemetry';

/**
 * Orchestrator-side telemetry wiring (#253 PR 2). Mirrors the API's
 * `TelemetryService`: one transport per process, the org's opt-in
 * flag is read fresh on every emit so toggling off stops emissions
 * within one event cycle.
 *
 * Kept lightweight (no NestJS DI here; the orchestrator is plain
 * Node) at the cost of duplicating a few lines with API's wiring.
 * If we grow a third caller, hoist into `@mergecrew/telemetry`.
 */
class OrchestratorTelemetry {
  private readonly transport: TelemetryTransport;
  private readonly version: string;

  constructor() {
    const url = process.env.MERGECREW_TELEMETRY_URL?.trim();
    this.transport = url ? new HttpTransport({ url }) : new NoopTransport();
    this.version = process.env.MERGECREW_VERSION ?? '0.1.0';
  }

  async emit(
    organizationId: string,
    type: TelemetryEvent['type'],
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const row = await withSystem((tx) =>
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { telemetryEnabled: true, telemetryInstallId: true },
        }),
      );
      if (!row?.telemetryEnabled || !row.telemetryInstallId) return;
      const emitter = new TelemetryEmitter(
        { enabled: true, installId: row.telemetryInstallId, version: this.version },
        this.transport,
      );
      await emitter.emit(type, fields as never);
    } catch {
      /* never fail the hot path */
    }
  }
}

export const telemetry = new OrchestratorTelemetry();
