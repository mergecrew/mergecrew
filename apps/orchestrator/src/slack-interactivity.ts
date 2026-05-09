import type { Logger } from 'pino';
import type { Queue } from 'bullmq';
import { withSystem, withTenant } from '@mergecrew/db';
import type { Eventlog } from '@mergecrew/eventlog';
import { SlackClient } from '@mergecrew/adapters-comms';

type DigestAction = 'promote' | 'rollback' | 'defer';

interface BlockAction {
  action_id?: string;
  value?: string;
}

interface BlockActionsPayload {
  type: string;
  user?: { id?: string; email?: string };
  response_url?: string;
  actions?: BlockAction[];
}

const DIGEST_PREFIX = 'digest:';

/** Parse `digest:{action}:{changesetId}` into its parts. */
export function parseDigestActionValue(value: string | undefined): { action: DigestAction; changesetId: string } | null {
  if (!value || !value.startsWith(DIGEST_PREFIX)) return null;
  const rest = value.slice(DIGEST_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const action = rest.slice(0, idx);
  const changesetId = rest.slice(idx + 1);
  if (!changesetId) return null;
  if (action !== 'promote' && action !== 'rollback' && action !== 'defer') return null;
  return { action, changesetId };
}

interface InteractivityDeps {
  logger: Logger;
  eventlog: Eventlog;
  dispatchQueue: Queue;
}

export async function handleSlackInteractivity(payload: unknown, deps: InteractivityDeps): Promise<void> {
  const { logger } = deps;
  const ev = payload as BlockActionsPayload | undefined;
  if (!ev || ev.type !== 'block_actions' || !Array.isArray(ev.actions)) {
    logger.info({ type: ev?.type }, 'slack interactivity: ignoring non-block_actions payload');
    return;
  }
  if (!ev.user?.id) {
    logger.warn('slack interactivity: missing user id');
    return;
  }

  const slackUserId = ev.user.id;
  const userRecord = await resolveUserFromSlack(slackUserId, ev.user.email, logger);
  if (!userRecord) {
    logger.warn({ slackUserId }, 'slack interactivity: cannot resolve to mergecrew user');
    if (ev.response_url) await postEphemeral(ev.response_url, 'Could not match your Slack account to a Mergecrew user.');
    return;
  }

  for (const action of ev.actions) {
    const parsed = parseDigestActionValue(action.value);
    if (!parsed) {
      logger.info({ value: action.value }, 'slack interactivity: skipping non-digest action');
      continue;
    }

    try {
      await applyDigestDecision({
        organizationId: userRecord.organizationId,
        userId: userRecord.userId,
        role: userRecord.role,
        changesetId: parsed.changesetId,
        action: parsed.action,
        deps,
      });
      if (ev.response_url) {
        await postReplace(ev.response_url, `:white_check_mark: ${capitalize(parsed.action)} recorded for \`${parsed.changesetId}\`.`);
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      logger.warn({ err: msg, changesetId: parsed.changesetId }, 'slack interactivity: decision failed');
      if (ev.response_url) await postEphemeral(ev.response_url, `:warning: ${capitalize(parsed.action)} failed: ${msg}`);
    }
  }
}

interface ResolvedUser {
  userId: string;
  organizationId: string;
  role: string;
}

async function resolveUserFromSlack(
  slackUserId: string,
  payloadEmail: string | undefined,
  logger: Logger,
): Promise<ResolvedUser | null> {
  let email = payloadEmail;
  if (!email && process.env.SLACK_BOT_TOKEN) {
    try {
      const r = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
        headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const j = (await r.json()) as any;
      if (j.ok) email = j.user?.profile?.email;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'slack users.info failed');
    }
  }
  if (!email) return null;

  const user = await withSystem((tx) => tx.user.findFirst({ where: { email } }));
  if (!user) return null;
  const membership = await withSystem((tx) => tx.membership.findFirst({ where: { userId: user.id } }));
  if (!membership) return null;
  return { userId: user.id, organizationId: membership.organizationId, role: membership.role };
}

interface ApplyArgs {
  organizationId: string;
  userId: string;
  role: string;
  changesetId: string;
  action: DigestAction;
  deps: InteractivityDeps;
}

async function applyDigestDecision(args: ApplyArgs): Promise<void> {
  const { organizationId, userId, role, changesetId, action, deps } = args;

  // Production promote requires operator+ — same invariant as the HTTP route.
  if (action === 'promote' && role !== 'owner' && role !== 'admin' && role !== 'operator') {
    throw new Error('promote requires operator role');
  }

  const cs = await withTenant(organizationId, (tx) =>
    tx.changeset.findFirst({ where: { id: changesetId, organizationId } }),
  );
  if (!cs) throw new Error('changeset not found');

  const decision = await withTenant(organizationId, (tx) =>
    tx.decision.create({
      data: {
        organizationId,
        changesetId,
        userId,
        kind: action,
        comment: null,
      },
    }),
  );

  await withTenant(organizationId, (tx) =>
    tx.changeset.update({
      where: { id: changesetId },
      data: {
        status: action === 'promote' ? 'promoted' : action === 'rollback' ? 'rolled_back' : 'deferred',
        updatedAt: new Date(),
      },
    }),
  );

  if (action === 'promote' || action === 'rollback') {
    await deps.dispatchQueue.add(
      action,
      { changesetId, organizationId, userId, projectId: cs.projectId },
      { removeOnComplete: 1000 },
    );
  }

  await deps.eventlog.emit({
    organizationId,
    projectId: cs.projectId,
    dailyRunId: cs.dailyRunId,
    changesetId,
    type:
      action === 'promote'
        ? 'CHANGESET_PROMOTED'
        : action === 'rollback'
          ? 'CHANGESET_ROLLED_BACK'
          : 'AGENT_DECISION',
    actor: { kind: 'user', id: userId },
    payload: { kind: action, source: 'slack', decisionId: decision.id },
  });
}

async function postReplace(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }),
  }).catch(() => undefined);
}

async function postEphemeral(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  }).catch(() => undefined);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Re-export so callers don't need to know about the SlackClient just to wire deps.
export { SlackClient };
