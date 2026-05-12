import type { Logger } from 'pino';
import { withSystem } from '@mergecrew/db';
import {
  HttpTransport,
  NoopTransport,
  TelemetryEmitter,
  type TelemetryTransport,
} from '@mergecrew/telemetry';

/**
 * Daily install-ping tick (#322).
 *
 * Emits one `install.ping` per UTC day when at least one org in the
 * install has `telemetryEnabled = true`. The payload is aggregate-only
 * (orgCount, projectCount, evalsEnabledOrgCount, deployKind) — no
 * slugs, no titles, no identifiers beyond the install UUID.
 *
 * The install UUID is whichever telemetry-opted-in org has the oldest
 * `createdAt`, which is stable across restarts and reuses the existing
 * `telemetryInstallId` plumbing — no new schema column needed.
 *
 * Dedup is via the in-process `lastPingedDay` variable. A worker-cron
 * restart inside the same day re-emits, which is fine: the receiver
 * idempotently overwrites the latest counts.
 */
export interface InstallPingPayload {
  installId: string;
  version: string;
  deployKind: 'compose' | 'kubernetes' | 'unknown';
  orgCount: number;
  projectCount: number;
  evalsEnabledOrgCount: number;
}

let lastPingedDay: string | null = null;

function detectDeployKind(): InstallPingPayload['deployKind'] {
  // KUBERNETES_SERVICE_HOST is injected by kubelet on every pod.
  if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  // The compose service `mergecrew-worker-cron` resolves to this hostname.
  // Heuristic: if /etc/hostname matches `mergecrew-*` or COMPOSE_PROJECT_NAME
  // is set, we're in compose.
  if (process.env.COMPOSE_PROJECT_NAME || process.env.HOSTNAME?.startsWith('mergecrew-')) {
    return 'compose';
  }
  return 'unknown';
}

/**
 * Read the payload that *would* be sent if the next tick fires. Used
 * by `pnpm telemetry:preview` and the Settings UI. Returns null when
 * no org has opted in (which is the default), so callers can render
 * "no ping configured" cleanly.
 */
export async function buildInstallPingPayload(version: string): Promise<InstallPingPayload | null> {
  const optedIn = await withSystem((tx) =>
    tx.organization.findFirst({
      where: { telemetryEnabled: true, telemetryInstallId: { not: null }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { telemetryInstallId: true },
    }),
  );
  if (!optedIn?.telemetryInstallId) return null;

  const [orgCount, projectCount, evalsEnabledOrgCount] = await Promise.all([
    withSystem((tx) => tx.organization.count({ where: { deletedAt: null } })),
    withSystem((tx) => tx.project.count({ where: { deletedAt: null } })),
    withSystem((tx) => tx.organization.count({ where: { evalsEnabled: true, deletedAt: null } })),
  ]);

  return {
    installId: optedIn.telemetryInstallId,
    version,
    deployKind: detectDeployKind(),
    orgCount,
    projectCount,
    evalsEnabledOrgCount,
  };
}

export async function installPingTick(deps: {
  logger: Logger;
  version?: string;
  now?: Date;
  /** Override for tests; production path constructs from MERGECREW_TELEMETRY_URL. */
  transport?: TelemetryTransport;
}): Promise<void> {
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  if (lastPingedDay === today) return;

  const version = deps.version ?? process.env.MERGECREW_VERSION ?? '0.1.0';
  const payload = await buildInstallPingPayload(version);
  if (!payload) {
    // Mark the day as "checked" even when no org has opted in so we
    // don't query the DB on every 60s tick.
    lastPingedDay = today;
    return;
  }

  const url = process.env.MERGECREW_TELEMETRY_URL?.trim();
  const transport = deps.transport ?? (url ? new HttpTransport({ url }) : new NoopTransport());

  const emitter = new TelemetryEmitter(
    { enabled: true, installId: payload.installId, version },
    transport,
  );
  await emitter.emit('install.ping', {
    deployKind: payload.deployKind,
    orgCount: payload.orgCount,
    projectCount: payload.projectCount,
    evalsEnabledOrgCount: payload.evalsEnabledOrgCount,
  } as never);

  lastPingedDay = today;
  deps.logger.info(
    {
      orgCount: payload.orgCount,
      projectCount: payload.projectCount,
      deployKind: payload.deployKind,
    },
    'install-ping: emitted',
  );
}

// Test-only: reset the in-process dedup state.
export function _resetForTests(): void {
  lastPingedDay = null;
}
