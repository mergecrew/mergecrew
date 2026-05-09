import type { Logger } from 'pino';
import { withSystem, withTenant } from '@mergecrew/db';

/**
 * Prune `audit_log_entries` older than each org's
 * `complianceAuditRetention` (days). Idempotent — re-running on the same
 * day is a no-op once today's deletes have happened. The cross-tenant
 * orchestration uses `withSystem` to enumerate orgs, then `withTenant` for
 * the actual delete so RLS predicates apply uniformly.
 */
export async function auditRetentionTick(deps: { logger: Logger; now?: Date }): Promise<void> {
  const { logger } = deps;
  const now = deps.now ?? new Date();

  const orgs = await withSystem((tx) =>
    tx.organization.findMany({
      where: { deletedAt: null },
      select: { id: true, complianceAuditRetention: true },
    }),
  );

  for (const o of orgs) {
    const days = o.complianceAuditRetention;
    if (!Number.isFinite(days) || days <= 0) continue;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    try {
      const deleted = await withTenant(o.id, (tx) =>
        tx.auditLogEntry.deleteMany({
          where: { occurredAt: { lt: cutoff } },
        }),
      );
      if (deleted.count > 0) {
        logger.info(
          { orgId: o.id, deleted: deleted.count, cutoff: cutoff.toISOString(), retentionDays: days },
          'retention.audit_log_pruned',
        );
      }
    } catch (err) {
      logger.warn(
        { orgId: o.id, err: (err as Error)?.message ?? String(err) },
        'retention.audit_log_prune_failed',
      );
    }
  }
}
