import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import {
  EmailClient,
  buildDigestEmail,
  emailConfigFromEnv,
  emailEnabledFromEnv,
  type DigestChangeset,
} from '@mergecrew/adapters-comms';
import { collectDigestAnomalies } from './digest-anomalies.js';

const ACTIVE_STATUSES = ['testing', 'tests_failed', 'pr_open', 'dev_deployed'] as const;

export async function dispatchEmailDigest(args: {
  organizationId: string;
  projectId: string;
  eod: Date;
  logger: Logger;
}): Promise<void> {
  const { organizationId, projectId, eod, logger } = args;

  const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
  if (!emailEnabledFromEnv() && process.env.NODE_ENV === 'production') {
    logger.warn(
      { projectId },
      'digest.email: neither SMTP_URL nor RESEND_API_KEY set in prod; skipping',
    );
    return;
  }
  const email = new EmailClient(emailConfigFromEnv());

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

  // V2.aa Guardrails anomaly highlights (#288). Detector errors are
  // swallowed inside collectDigestAnomalies so a bad query never blocks
  // the digest from sending.
  const anomalies = await collectDigestAnomalies({
    organizationId,
    projectId,
    orgSlug: project.organization.slug,
    projectSlug: project.slug,
    eod,
    webBaseUrl,
  }).catch((err) => {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), projectId },
      'digest.email: anomaly collection failed; rendering without highlights',
    );
    return [];
  });

  // Suppress empty digests (#635). "No active changesets today" with no
  // anomalies is no signal — silence is better than training recipients
  // to ignore the digest. lastDigestAt was bumped at enqueue, so the
  // next eod still computes "due" correctly.
  if (changesets.length === 0 && anomalies.length === 0) {
    logger.info(
      { projectId, eod: eod.toISOString() },
      'digest.email: no changesets and no anomalies; skipping send',
    );
    return;
  }

  const { subject, html } = buildDigestEmail({
    orgSlug: project.organization.slug,
    orgName: project.organization.name,
    project: { slug: project.slug, name: project.name },
    changesets,
    anomalies,
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
