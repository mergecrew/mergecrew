import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import { SlackClient, buildDigestBlocks, type DigestChangeset } from '@mergecrew/adapters-comms';

const ACTIVE_STATUSES = ['testing', 'tests_failed', 'pr_open', 'dev_deployed'] as const;

export async function dispatchSlackDigest(args: {
  organizationId: string;
  projectId: string;
  eod: Date;
  logger: Logger;
}): Promise<void> {
  const { organizationId, projectId, eod, logger } = args;

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn({ projectId }, 'digest.slack: no SLACK_BOT_TOKEN; skipping');
    return;
  }
  const slack = new SlackClient({ botToken });

  const project = await withTenant(organizationId, (tx) =>
    tx.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, name: true },
    }),
  );
  if (!project) {
    logger.warn({ projectId }, 'digest.slack: project not found');
    return;
  }

  const since = startOfDay(eod);
  const csRows = await withTenant(organizationId, (tx) =>
    tx.changeset.findMany({
      where: {
        projectId,
        status: { in: [...ACTIVE_STATUSES] },
        updatedAt: { gte: since },
      },
      select: {
        id: true,
        title: true,
        whyParagraph: true,
        status: true,
        riskChip: true,
        prNumber: true,
        prUrl: true,
      },
      orderBy: { updatedAt: 'desc' },
    }),
  );
  const changesets: DigestChangeset[] = csRows.map((r) => ({
    ...r,
    status: String(r.status),
  }));

  const memberships = await withTenant(organizationId, (tx) =>
    tx.membership.findMany({
      where: { organizationId },
      include: { user: { select: { email: true } } },
    }),
  );
  const recipients = memberships
    .map((m) => m.user.email)
    .filter((e): e is string => !!e);

  if (recipients.length === 0) {
    logger.info({ projectId }, 'digest.slack: no recipients with email');
    return;
  }

  const { text, blocks } = buildDigestBlocks({
    project: { slug: project.slug, name: project.name },
    changesets,
    eod,
  });

  let delivered = 0;
  for (const email of recipients) {
    try {
      const userId = await slack.lookupUserByEmail(email);
      if (!userId) {
        logger.info({ email }, 'digest.slack: no slack user for email; skipping');
        continue;
      }
      const channel = await slack.openDm(userId);
      await slack.post(channel, text, blocks);
      delivered++;
    } catch (err) {
      logger.warn(
        { email, err: (err as Error)?.message ?? String(err) },
        'digest.slack: per-recipient delivery failed',
      );
    }
  }

  logger.info(
    { projectId, eod: eod.toISOString(), delivered, recipients: recipients.length },
    'digest.slack: dispatched',
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
