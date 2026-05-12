/**
 * HTML email rendering for the end-of-working-hours digest. Plain
 * inline-styled markup so it survives any mail client. Deep links go
 * to the web app's /digest page where promote/rollback/defer can be
 * resolved with full org context.
 */

import type { DigestAnomaly, DigestChangeset, DigestProject } from './digest-blocks.js';

export interface DigestEmailArgs {
  orgSlug: string;
  orgName: string;
  project: DigestProject;
  changesets: DigestChangeset[];
  /** Anomaly highlights from the V2.aa guardrails (#288). Empty array = no section rendered. */
  anomalies?: DigestAnomaly[];
  eod: Date;
  webBaseUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function buildDigestEmail(args: DigestEmailArgs): RenderedEmail {
  const { orgSlug, orgName, project, changesets, anomalies = [], eod, webBaseUrl } = args;
  const dateStr = eod.toISOString().slice(0, 10);
  const subject = `[${orgName}] ${project.name} digest — ${dateStr}`;

  const digestUrl = `${webBaseUrl}/orgs/${orgSlug}/projects/${project.slug}/digest/${dateStr}`;

  const anomaliesBlock = anomalies.length > 0 ? renderAnomalies(anomalies) : '';
  const rows = changesets.length
    ? changesets.map((cs) => renderRow(cs, digestUrl)).join('\n')
    : `<tr><td style="padding:16px;color:#777;font-style:italic;">No active changesets today.</td></tr>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e6e8eb;">
        <tr>
          <td style="padding:20px 24px;border-bottom:1px solid #e6e8eb;">
            <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(orgName)}</div>
            <div style="font-size:20px;font-weight:600;color:#111827;margin-top:2px;">${escapeHtml(project.name)} · daily digest</div>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">${dateStr} · ${changesets.length} changeset${changesets.length === 1 ? '' : 's'}</div>
          </td>
        </tr>
        ${anomaliesBlock}
        ${rows}
        <tr>
          <td style="padding:16px 24px;background:#fafbfc;font-size:12px;color:#6b7280;">
            <a href="${escapeAttr(digestUrl)}" style="color:#2563eb;text-decoration:none;">Open digest in Mergecrew →</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

function renderRow(cs: DigestChangeset, digestUrl: string): string {
  const anchor = `${digestUrl}#changeset-${cs.id}`;
  const why = cs.whyParagraph ?? '';
  const meta: string[] = [`status: <code>${escapeHtml(cs.status)}</code>`];
  if (cs.riskChip) meta.push(`risk: <code>${escapeHtml(cs.riskChip)}</code>`);
  if (cs.prNumber && cs.prUrl) {
    meta.push(`<a href="${escapeAttr(cs.prUrl)}" style="color:#2563eb;text-decoration:none;">PR #${cs.prNumber}</a>`);
  }

  return `<tr>
    <td style="padding:16px 24px;border-top:1px solid #e6e8eb;">
      <div style="font-size:14px;font-weight:600;color:#111827;">${escapeHtml(cs.title)}</div>
      ${why ? `<div style="font-size:13px;color:#374151;margin-top:6px;line-height:1.5;">${escapeHtml(why)}</div>` : ''}
      <div style="font-size:12px;color:#6b7280;margin-top:8px;">${meta.join(' · ')}</div>
      <div style="margin-top:10px;">
        <a href="${escapeAttr(anchor)}?action=promote" style="display:inline-block;padding:6px 12px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;">Promote</a>
        <a href="${escapeAttr(anchor)}?action=rollback" style="display:inline-block;padding:6px 12px;background:#dc2626;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;margin-left:6px;">Rollback</a>
        <a href="${escapeAttr(anchor)}?action=defer" style="display:inline-block;padding:6px 12px;background:#e5e7eb;color:#111827;border-radius:6px;text-decoration:none;font-size:12px;margin-left:6px;">Defer</a>
      </div>
    </td>
  </tr>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Anomaly highlights block (#288). Rendered as one `<tr>` containing
 * an inner table of bullets so the section reads at-a-glance above the
 * full changeset list. Only called when anomalies.length > 0 — never
 * pads the digest with an empty section.
 */
function renderAnomalies(anomalies: DigestAnomaly[]): string {
  const items = anomalies.map((a) => `<li style="margin:6px 0;">${renderAnomalyItem(a)}</li>`).join('');
  return `<tr>
    <td style="padding:16px 24px;background:#fffbeb;border-top:1px solid #e6e8eb;border-bottom:1px solid #e6e8eb;">
      <div style="font-size:12px;font-weight:600;color:#92400e;text-transform:uppercase;letter-spacing:0.04em;">
        Anomalies this period
      </div>
      <ul style="margin:8px 0 0 0;padding-left:18px;font-size:13px;color:#374151;">${items}</ul>
    </td>
  </tr>`;
}

function renderAnomalyItem(a: DigestAnomaly): string {
  const link = (text: string, href: string) =>
    `<a href="${escapeAttr(href)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(text)}</a>`;
  switch (a.kind) {
    case 'cost_spike':
      return `<strong>Cost spike:</strong> today $${a.todayUsd.toFixed(2)} vs trailing-7-day avg $${a.avgUsd.toFixed(2)} (${a.multiplier.toFixed(1)}×). ${link('View costs →', a.link)}`;
    case 'blocked_changeset':
      return `<strong>Changeset blocked:</strong> ${link(a.title, a.link)} — reason: <code>${escapeHtml(a.reason)}</code>`;
    case 'risk_gate_hit':
      return `<strong>Risk-score gate:</strong> ${link(a.title, a.link)} — score ${a.score.toFixed(1)} &gt; threshold ${a.threshold}`;
    case 'rollback':
      return `<strong>Rolled back:</strong> ${link(a.title, a.link)} — revert PR #${a.revertPrNumber}`;
    case 'file_spike':
      return `<strong>File-count spike:</strong> ${link(a.title, a.link)} touched ${a.filesChanged} files (median: ${a.medianFiles})`;
  }
}
