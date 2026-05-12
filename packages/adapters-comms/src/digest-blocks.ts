/**
 * Block-kit builder for the end-of-working-hours digest DM.
 *
 * Action button payloads use the convention `digest:{action}:{changesetId}`
 * so the interactivity webhook (#81) can parse them with one split. Keep
 * the format frozen — Slack's actions store the value verbatim.
 */

export interface DigestChangeset {
  id: string;
  title: string;
  whyParagraph: string | null;
  status: string;
  riskChip: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface DigestProject {
  slug: string;
  name: string;
}

/**
 * Anomaly highlight surfaced at the top of the daily digest (#288).
 * Five kinds covering the V2.aa guardrails:
 *   - cost_spike: today's LLM spend was > 2× the trailing-7-day daily avg
 *   - blocked_changeset: a changeset was rejected by the blast-radius gate
 *   - risk_gate_hit: a changeset landed in the inbox via the risk-score gate
 *   - rollback: an admin rolled back a merged changeset
 *   - file_spike: a single changeset touched >2× the trailing-30-day median
 *
 * `link` is a deep link the email + slack renderers wrap appropriately
 * (`mailto:` for email digests, `<url|text>` for slack mrkdwn).
 */
export type DigestAnomaly =
  | {
      kind: 'cost_spike';
      todayUsd: number;
      avgUsd: number;
      multiplier: number;
      link: string;
    }
  | {
      kind: 'blocked_changeset';
      changesetId: string;
      title: string;
      reason: string;
      link: string;
    }
  | {
      kind: 'risk_gate_hit';
      changesetId: string;
      title: string;
      score: number;
      threshold: number;
      link: string;
    }
  | {
      kind: 'rollback';
      changesetId: string;
      title: string;
      revertPrNumber: number;
      link: string;
    }
  | {
      kind: 'file_spike';
      changesetId: string;
      title: string;
      filesChanged: number;
      medianFiles: number;
      link: string;
    };

export type DigestAction = 'promote' | 'rollback' | 'defer';

export function buildDigestBlocks(args: {
  project: DigestProject;
  changesets: DigestChangeset[];
  eod: Date;
}): { text: string; blocks: any[] } {
  const { project, changesets, eod } = args;
  const dateStr = eod.toISOString().slice(0, 10);
  const headerText = `Daily digest — ${project.name} · ${dateStr}`;

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: false },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${changesets.length} changeset${changesets.length === 1 ? '' : 's'} ready for review`,
        },
      ],
    },
    { type: 'divider' },
  ];

  if (changesets.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active changesets today._' },
    });
    return { text: headerText, blocks };
  }

  for (const cs of changesets) {
    const lines: string[] = [`*${escapeMrkdwn(cs.title)}*`];
    if (cs.whyParagraph) lines.push(escapeMrkdwn(cs.whyParagraph));
    const meta: string[] = [`status: \`${cs.status}\``];
    if (cs.riskChip) meta.push(`risk: \`${cs.riskChip}\``);
    if (cs.prNumber && cs.prUrl) meta.push(`<${cs.prUrl}|PR #${cs.prNumber}>`);
    lines.push(meta.join(' · '));

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    });
    blocks.push({
      type: 'actions',
      block_id: `digest:${cs.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Promote', emoji: false },
          style: 'primary',
          action_id: `digest:promote:${cs.id}`,
          value: `digest:promote:${cs.id}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Rollback', emoji: false },
          style: 'danger',
          action_id: `digest:rollback:${cs.id}`,
          value: `digest:rollback:${cs.id}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Defer', emoji: false },
          action_id: `digest:defer:${cs.id}`,
          value: `digest:defer:${cs.id}`,
        },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  return { text: headerText, blocks };
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
