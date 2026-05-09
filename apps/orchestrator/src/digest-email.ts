import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import {
  EmailClient,
  buildDigestEmail,
  type DigestChangeset,
} from '@mergecrew/adapters-comms';

const ACTIVE_STATUSES = ['testing', 'tests_failed', 'pr_open', 'dev_deployed'] as const;

export async function dispatchEmailDigest(args: {
  organizationId: string;
  projectId: string;
  eod: Date;
  logger: Logger;
}): Promise<void> {
  const { organizationId, projectId, eod, logger } = args;

  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.MERGECREW_EMAIL_FROM ?? 'noreply@mergecrew.dev';
  const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
  if (!smtpUrl && process.env.NODE_ENV === 'production') {
    logger.warn({ projectId }, 'digest.email: SMTP_URL not set in prod; skipping');
    return;
  }
  const email = new EmailClient({ from, smtpUrl });

  const project = await withTenant(organizationId, (tx) =>
    tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        slug: true,
        name: true,
        organization: { select: { slug: true, name: true } },
      },
    }),
  );
  if (!project) {
    logger.warn({ projectId }, 'digest.email: project not found');
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
  const changesets: DigestChangeset[] = csRows.map((r) => ({ ...r, status: String(r.status) }));

  const memberships = await withTenant(organizationId, (tx) =>
    tx.membership.findMany({ where: { organizationId }, include: { user: { select: { email: true } } } }),
  );
  const recipients = memberships.map((m) => m.user.email).filter((e): e is string => !!e);
  if (recipients.length === 0) {
    logger.info({ projectId }, 'digest.email: no recipients with email');
    return;
  }

  const { subject, html } = buildDigestEmail({
    orgSlug: project.organization.slug,
    orgName: project.organization.name,
    project: { slug: project.slug, name: project.name },
    changesets,
    eod,
    webBaseUrl,
  });

  try {
    await email.send(recipients, subject, html);
    logger.info({ projectId, eod: eod.toISOString(), recipients: recipients.length }, 'digest.email: dispatched');
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message ?? String(err), projectId },
      'digest.email: send failed',
    );
    throw err; // let bullmq retry
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
