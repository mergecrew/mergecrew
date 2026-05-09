import type { Logger } from 'pino';
import { withSystem, withTenant } from '@mergecrew/db';

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h

interface SentryEvent {
  action?: string;
  data?: {
    issue?: {
      id?: string | number;
      shortId?: string;
      title?: string;
      project?: { slug?: string };
    };
    event?: { issue_id?: string };
  };
  installation?: { uuid?: string };
}

/**
 * Handler for `webhook.inbound`/sentry jobs. Resolves which mergecrew
 * project owns the Sentry project (by error_target.config.project) and
 * inserts a synthetic intent inbox item the next discovery run will
 * pick up. Idempotent within DEDUP_WINDOW_MS via source_key.
 *
 * Returns the inserted intent's id, or null if nothing was queued (no
 * matching project, malformed payload, or duplicate suppressed).
 */
export async function handleSentryWebhook(args: {
  payload: unknown;
  logger: Logger;
}): Promise<string | null> {
  const { logger } = args;
  const ev = (args.payload ?? {}) as SentryEvent;

  const issue = ev.data?.issue;
  if (!issue) {
    logger.info({ action: ev.action }, 'sentry webhook: no issue payload');
    return null;
  }
  const issueId = String(issue.id ?? issue.shortId ?? '');
  const sentryProjectSlug = issue.project?.slug;
  if (!issueId || !sentryProjectSlug) {
    logger.warn({ issueId, sentryProjectSlug }, 'sentry webhook: missing issue id or project');
    return null;
  }

  // Cross-tenant lookup — match by Sentry project slug. Prisma JSON path
  // filtering on PG isn't ergonomic without raw SQL; given the small row
  // count, fetch all sentry targets and match in memory.
  const allTargets = await withSystem((tx) =>
    tx.errorTarget.findMany({
      where: { adapterId: 'sentry' },
      select: { organizationId: true, projectId: true, config: true },
    }),
  );
  const match = allTargets.find((t) => (t.config as any)?.project === sentryProjectSlug);
  if (!match) {
    logger.info({ sentryProjectSlug }, 'sentry webhook: no project mapped; ignoring');
    return null;
  }

  const sourceKey = `sentry:issue:${issueId}`;
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const recent = await withTenant(match.organizationId, (tx) =>
    tx.intentInboxItem.findFirst({
      where: { projectId: match.projectId, sourceKey, createdAt: { gte: since } },
    }),
  );
  if (recent) {
    logger.info({ sourceKey, sinceMs: DEDUP_WINDOW_MS }, 'sentry webhook: dedup hit; skipping');
    return null;
  }

  const title = issue.title?.trim() || `issue ${issueId}`;
  const body = `Sentry issue ${issueId}: ${title}`;
  const created = await withTenant(match.organizationId, (tx) =>
    tx.intentInboxItem.create({
      data: {
        organizationId: match.organizationId,
        projectId: match.projectId,
        submittedByUserId: null,
        body,
        sourceKey,
      },
    }),
  );
  logger.info({ id: created.id, sourceKey }, 'sentry webhook: intent created');
  return created.id;
}
