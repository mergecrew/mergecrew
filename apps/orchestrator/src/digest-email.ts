import type { Logger } from 'pino';
import crypto from 'node:crypto';
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
    tx.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          select: { id: true, email: true, emailDigestEnabled: true },
        },
      },
    }),
  );
  // Per-user opt-in (#748). Default is false; users flip the toggle via
  // /account or click the unsubscribe link to flip it back. No opt-in =
  // no email — same shape as Slack and webhooks (must be configured).
  const recipients = memberships
    .map((m) => m.user)
    .filter((u): u is { id: string; email: string; emailDigestEnabled: boolean } => {
      return !!u && !!u.email && u.emailDigestEnabled;
    });
  if (recipients.length === 0) {
    logger.info({ projectId }, 'digest.email: no opted-in recipients');
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

  // Per-user send so each recipient gets their own unsubscribe link.
  // Digest fan-out is rarely more than a few addresses per org; the
  // sequential send keeps retries simple and order deterministic.
  let sent = 0;
  for (const r of recipients) {
    const unsubscribeUrl = `${webBaseUrl}/account/unsubscribe?token=${encodeURIComponent(
      mintDigestUnsubscribeToken(r.id),
    )}`;
    const { subject, html } = buildDigestEmail({
      orgSlug: project.organization.slug,
      orgName: project.organization.name,
      project: { slug: project.slug, name: project.name },
      changesets,
      anomalies,
      eod,
      webBaseUrl,
      unsubscribeUrl,
    });
    try {
      await email.send([r.email], subject, html);
      sent++;
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message ?? String(err), projectId, userId: r.id },
        'digest.email: send failed for recipient',
      );
      // Continue to next recipient; one bad address shouldn't suppress
      // the digest for the rest of the org. bullmq retry semantics for
      // the whole job still apply only to thrown errors.
    }
  }
  logger.info({ projectId, eod: eod.toISOString(), sent, attempted: recipients.length }, 'digest.email: dispatched');
}

/**
 * Mint an unsubscribe token. Mirrors the API-side helper in
 * apps/api/src/modules/notifications/me.controller.ts — same secret
 * (`JWT_SECRET`), same scheme: `v1.<userId>.<exp>.<hmac>`. Centralizing
 * would mean a shared package; the surface is two helpers in different
 * apps and the format is documented inline.
 */
function mintDigestUnsubscribeToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
  const base = `v1|${userId}|${exp}`;
  const secret = process.env.JWT_SECRET ?? 'dev-secret';
  const sig = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return `v1.${userId}.${exp}.${sig}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
