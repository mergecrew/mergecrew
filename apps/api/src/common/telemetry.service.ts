import { Injectable } from '@nestjs/common';
import {
  HttpTransport,
  MemoryTransport,
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
 *
 * #273: every emit is also fanned out to an in-process `MemoryTransport`
 * so the Settings → Telemetry card can render a recent-events audit
 * panel. The audit buffer is bounded at 100 events per process and
 * filtered by installId at read time so multi-org installs don't leak
 * one org's events to another's settings page.
 */
@Injectable()
export class TelemetryService {
  private readonly transport: TelemetryTransport;
  private readonly audit: MemoryTransport;
  private readonly version: string;

  constructor(private readonly prisma: PrismaService) {
    const url = process.env.MERGECREW_TELEMETRY_URL?.trim();
    const configured = url ? new HttpTransport({ url }) : new NoopTransport();
    this.audit = new MemoryTransport(100);
    this.transport = new TeeTransport([configured, this.audit]);
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

  /**
   * Return the most-recent events buffered locally that match this
   * org's installId. Empty for orgs that have never opted in. Per
   * #273 the panel is intentionally per-process: orchestrator emits
   * (e.g., `run.completed` on the success path) won't appear here,
   * only API-side emits.
   */
  async getRecent(organizationId: string, limit: number = 10): Promise<TelemetryEvent[]> {
    const row = await this.prisma.withSystem((tx) =>
      tx.organization.findUnique({
        where: { id: organizationId },
        select: { telemetryInstallId: true },
      }),
    );
    if (!row?.telemetryInstallId) return [];
    const all = this.audit.snapshot();
    return all
      .filter((e) => e.installId === row.telemetryInstallId)
      .slice(-limit)
      .reverse();
  }
}

/** Fans one batch out to multiple transports. Failures are swallowed per-leg. */
class TeeTransport implements TelemetryTransport {
  constructor(private readonly legs: TelemetryTransport[]) {}
  async send(batch: TelemetryEvent[]): Promise<void> {
    await Promise.all(
      this.legs.map((t) =>
        t.send(batch).catch(() => {
          /* one leg failing must not break the others */
        }),
      ),
    );
  }
}
