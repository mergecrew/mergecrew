import { getSystemPrisma } from './client.js';

/**
 * Alert routing (V2.af / #749). One row per (organization, eventKind);
 * the dispatcher reads the row when an event fires and returns the
 * channels to fan out to. Empty array (or no row at all) means the
 * event is silenced.
 *
 * The set of event kinds is small and closed — adding a new kind
 * means a schema migration on the CHECK constraint. Channels are an
 * open set so adding (e.g.) `pagerduty` later doesn't touch the DB.
 */

export const ALERT_EVENT_KINDS = [
  'digest.daily',
  'run.failed',
  'slo.breaching',
  'slo.recovered',
] as const;
export type AlertEventKind = (typeof ALERT_EVENT_KINDS)[number];

export const ALERT_CHANNELS = ['slack', 'email-user'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * Default routes seeded on org creation. Conservative: digest goes to
 * user emails (each user gates further via #748 emailDigestEnabled);
 * SLO breaches go to Slack when configured; everything else is silent
 * until the operator opts in.
 */
export const DEFAULT_ROUTES: Record<AlertEventKind, AlertChannel[]> = {
  'digest.daily': ['email-user'],
  'run.failed': [],
  'slo.breaching': ['slack'],
  'slo.recovered': [],
};

/** Resolve the channels for an event. Falls back to the default. */
export async function resolveAlertChannels(
  organizationId: string,
  eventKind: AlertEventKind,
): Promise<AlertChannel[]> {
  const prisma = getSystemPrisma();
  const row = await prisma.alertRoute.findFirst({
    where: { organizationId, eventKind },
    select: { channels: true },
  });
  if (!row) return DEFAULT_ROUTES[eventKind];
  // Filter to known channels so a stale row with a removed channel
  // doesn't crash the dispatcher.
  return row.channels.filter((c): c is AlertChannel =>
    (ALERT_CHANNELS as readonly string[]).includes(c),
  );
}

/** Look up every route for an org. Missing rows are returned with default channels. */
export async function listOrgAlertRoutes(
  organizationId: string,
): Promise<Array<{ eventKind: AlertEventKind; channels: AlertChannel[]; isDefault: boolean }>> {
  const prisma = getSystemPrisma();
  const rows = await prisma.alertRoute.findMany({
    where: { organizationId },
    select: { eventKind: true, channels: true },
  });
  const byKind = new Map(rows.map((r) => [r.eventKind, r.channels]));
  return ALERT_EVENT_KINDS.map((kind) => {
    const stored = byKind.get(kind);
    if (stored) {
      return {
        eventKind: kind,
        channels: stored.filter((c): c is AlertChannel =>
          (ALERT_CHANNELS as readonly string[]).includes(c),
        ),
        isDefault: false,
      };
    }
    return {
      eventKind: kind,
      channels: DEFAULT_ROUTES[kind],
      isDefault: true,
    };
  });
}
