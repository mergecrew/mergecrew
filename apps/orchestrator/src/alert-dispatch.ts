import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { withTenant, resolveAlertChannels, type AlertEventKind } from '@mergecrew/db';
import { SlackClient } from '@mergecrew/adapters-comms';

/**
 * Alert dispatcher (V2.af / #749). Maps timeline event types to alert
 * event kinds, resolves the org's configured channels for that kind,
 * and fans out. Today: Slack (org-level webhook from #747). Email-user
 * is honored by the existing digest pipeline (#748) which already
 * filters by per-user opt-in; this dispatcher doesn't double-send.
 *
 * Best-effort: a failed delivery is logged but never throws — the
 * timeline row is already durable and the operator can replay from
 * the activity stream if a channel was wedged.
 */

const TYPE_TO_KIND: Record<string, AlertEventKind> = {
  SLO_BREACHING: 'slo.breaching',
  SLO_RECOVERED: 'slo.recovered',
  RUN_FAILED: 'run.failed',
  DIGEST_DISPATCHED: 'digest.daily',
};

export async function dispatchAlertForEvent(args: {
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  logger: Logger;
}): Promise<void> {
  const { organizationId, eventType, payload, logger } = args;
  const kind = TYPE_TO_KIND[eventType];
  if (!kind) return;

  let channels;
  try {
    channels = await resolveAlertChannels(organizationId, kind);
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), organizationId, eventType },
      'alert.route_lookup_failed',
    );
    return;
  }
  if (channels.length === 0) return;

  if (channels.includes('slack')) {
    try {
      await dispatchSlack({ organizationId, eventType, payload, logger });
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message ?? String(err), organizationId, eventType },
        'alert.slack_dispatch_failed',
      );
    }
  }
  // 'email-user' is delivered by the existing digest pipeline (#748)
  // for digest.daily and is not wired for other kinds yet — those
  // surface only on the in-app activity stream. When per-user email
  // for SLO breaches lands, the channel is read here.
}

async function dispatchSlack(args: {
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  logger: Logger;
}): Promise<void> {
  const { organizationId, eventType, payload, logger } = args;
  const org = await withTenant(organizationId, (tx) =>
    tx.organization.findFirst({
      where: { id: organizationId },
      select: { slackWebhookCiphertext: true, slug: true, name: true },
    }),
  );
  if (!org?.slackWebhookCiphertext) return;

  let url: string;
  try {
    url = decryptEnvelope(Buffer.from(org.slackWebhookCiphertext));
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? String(err), organizationId },
      'alert.slack_decrypt_failed',
    );
    return;
  }

  const text = formatSlackMessage(eventType, payload, org);
  const client = new SlackClient({ webhookUrl: url });
  await client.post('', text);
}

function formatSlackMessage(
  eventType: string,
  payload: Record<string, unknown> | null,
  org: { slug: string; name: string },
): string {
  const p = payload ?? {};
  switch (eventType) {
    case 'SLO_BREACHING': {
      const name = String(p.name ?? 'SLO');
      const metric = String(p.metric ?? '');
      const current = formatMetric(metric, p.current);
      const thr = formatMetric(metric, p.threshold);
      const cmp = p.comparator === 'gte' ? '≥' : '≤';
      return `:rotating_light: [${org.name}] SLO breaching — *${name}* (${metric} ${cmp} ${thr}) — current ${current}`;
    }
    case 'SLO_RECOVERED': {
      const name = String(p.name ?? 'SLO');
      return `:white_check_mark: [${org.name}] SLO recovered — *${name}*`;
    }
    case 'RUN_FAILED': {
      const runId = String(p.dailyRunId ?? p.runId ?? '');
      return `:x: [${org.name}] Daily run failed${runId ? ` — \`${runId}\`` : ''}`;
    }
    case 'DIGEST_DISPATCHED': {
      const project = String(p.projectSlug ?? '');
      return `:newspaper: [${org.name}] Daily digest dispatched${project ? ` for *${project}*` : ''}`;
    }
    default:
      return `[${org.name}] ${eventType}`;
  }
}

function formatMetric(metric: string, value: unknown): string {
  if (value == null) return '—';
  const v = Number(value);
  if (!Number.isFinite(v)) return String(value);
  switch (metric) {
    case 'stepPassRate':
    case 'runFailureRate':
      return `${v.toFixed(1)}%`;
    case 'p95StepMs':
      if (v >= 60_000) return `${(v / 60_000).toFixed(1)}m`;
      if (v >= 1_000) return `${(v / 1_000).toFixed(1)}s`;
      return `${Math.round(v)}ms`;
    case 'dailyCostUsd':
      return `$${v.toFixed(2)}`;
    default:
      return String(v);
  }
}

/**
 * Decrypt an envelope-encrypted blob using the format produced by
 * CryptoService in apps/api. Layout:
 *   [1B version][12B wrapIv][16B wrapTag][32B wrapped][12B iv][16B tag][N ct]
 * Master key comes from KMS_MASTER_KEY (`base64:` prefix, 32 bytes).
 */
function decryptEnvelope(blob: Buffer): string {
  if (blob[0] !== 1) throw new Error('unknown ciphertext version');
  const masterEnv = process.env.KMS_MASTER_KEY ?? '';
  if (!masterEnv.startsWith('base64:')) throw new Error('KMS_MASTER_KEY must start with base64:');
  const masterKey = Buffer.from(masterEnv.slice(7), 'base64');
  if (masterKey.length !== 32) throw new Error('KMS_MASTER_KEY must be 32 bytes');

  let pos = 1;
  const wrapIv = blob.subarray(pos, pos + 12); pos += 12;
  const wrapTag = blob.subarray(pos, pos + 16); pos += 16;
  const wrapped = blob.subarray(pos, pos + 32); pos += 32;
  const iv = blob.subarray(pos, pos + 12); pos += 12;
  const tag = blob.subarray(pos, pos + 16); pos += 16;
  const ct = blob.subarray(pos);

  const wrapDecipher = crypto.createDecipheriv('aes-256-gcm', masterKey, wrapIv);
  wrapDecipher.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([wrapDecipher.update(wrapped), wrapDecipher.final()]);

  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
