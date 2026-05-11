import { Injectable } from '@nestjs/common';
import {
  HttpTransport,
  NoopTransport,
  TelemetryEmitter,
  type TelemetryEvent,
  type TelemetryTransport,
} from '@mergecrew/telemetry';
import { PrismaService } from './prisma.service.js';

/**
 * Process-level telemetry wiring (#253 PR 2). One transport instance
 * per process; one emitter per emit call, since the install id is
 * org-scoped and read fresh from the DB so toggling stops emissions
 * within one request cycle (privacy invariant in the schema doc).
 *
 * Transport choice is driven by `MERGECREW_TELEMETRY_URL`:
 *   - empty / unset → `NoopTransport` (no outbound HTTP, ever)
 *   - set           → `HttpTransport` POSTing to that URL
 *
 * The default is empty even on `docker-compose.full.yml`. Operators
 * wanting signal point this at the reference receiver under
 * `infra/telemetry/` (or at their own collector).
 */
@Injectable()
export class TelemetryService {
  private readonly transport: TelemetryTransport;
  private readonly version: string;

  constructor(private readonly prisma: PrismaService) {
    const url = process.env.MERGECREW_TELEMETRY_URL?.trim();
    this.transport = url ? new HttpTransport({ url }) : new NoopTransport();
    this.version = process.env.MERGECREW_VERSION ?? '0.1.0';
  }

  /**
   * Emit one event for the given org. Cheap to call: when telemetry
   * is off (the default) the row read is a single indexed lookup and
   * the emitter short-circuits before the transport. Wrap-in-try ensures
   * a misconfigured DB / transport never poisons the caller.
   */
  async emit(
    organizationId: string,
    type: TelemetryEvent['type'],
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const row = await this.prisma.withSystem((tx) =>
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
