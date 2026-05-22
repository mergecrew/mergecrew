'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { setAlertRouteAction, type AlertRoutesResponse } from './alert-routes-actions';

type Row = AlertRoutesResponse['items'][number];

const KIND_LABELS: Record<Row['eventKind'], { label: string; help: string }> = {
  'digest.daily': {
    label: 'Daily digest',
    help: 'End-of-working-hours summary, one per project per day.',
  },
  'run.failed': {
    label: 'Run failure',
    help: 'A daily run terminated in `failed` status.',
  },
  'slo.breaching': {
    label: 'SLO breaching',
    help: 'A project SLO crossed into BREACHING.',
  },
  'slo.recovered': {
    label: 'SLO recovered',
    help: 'A previously-breaching SLO is back to OK.',
  },
};

const CHANNELS: Array<{ id: 'slack' | 'email-user'; label: string }> = [
  { id: 'slack', label: 'Slack' },
  { id: 'email-user', label: 'Email (per user)' },
];

export function AlertRoutesForm({
  slug,
  initial,
  canEdit,
  slackConfigured,
}: {
  slug: string;
  initial: AlertRoutesResponse;
  canEdit: boolean;
  slackConfigured: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(initial.items);

  return (
    <div className="space-y-3">
      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
            <tr className="border-b border-ink">
              <th className="px-4 py-2 font-medium">Event</th>
              {CHANNELS.map((c) => (
                <th key={c.id} className="px-4 py-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RouteRow
                key={row.eventKind}
                slug={slug}
                row={row}
                canEdit={canEdit}
                slackConfigured={slackConfigured}
                onChange={(next) =>
                  setRows((arr) =>
                    arr.map((r) => (r.eventKind === next.eventKind ? next : r)),
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </Card>
      <p className="m-0 text-[12px] text-muted">
        Changes apply on the next event — no restart needed. Rows still on the
        seeded default are marked with a small chip; toggling any channel writes
        an explicit route.
      </p>
      {!canEdit && (
        <p className="m-0 text-[12px] text-muted">Only admins can edit alert routes.</p>
      )}
    </div>
  );
}

function RouteRow({
  slug,
  row,
  canEdit,
  slackConfigured,
  onChange,
}: {
  slug: string;
  row: Row;
  canEdit: boolean;
  slackConfigured: boolean;
  onChange: (r: Row) => void;
}) {
  const [pending, startTransition] = useTransition();
  const meta = KIND_LABELS[row.eventKind];

  const toggle = (channel: 'slack' | 'email-user') => {
    if (!canEdit || pending) return;
    const next = row.channels.includes(channel)
      ? row.channels.filter((c) => c !== channel)
      : [...row.channels, channel];
    startTransition(async () => {
      try {
        const updated = await setAlertRouteAction(slug, row.eventKind, next);
        onChange(updated);
      } catch {
        /* swallow — UI didn't optimistically update */
      }
    });
  };

  return (
    <tr className="border-b border-hair-2 last:border-b-0">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{meta?.label}</span>
          {row.isDefault && (
            <span className="border border-hair px-[6px] py-[1px] font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              default
            </span>
          )}
        </div>
        <div className="font-mono text-[11px] text-muted">{meta?.help}</div>
      </td>
      {CHANNELS.map((c) => {
        const disabledReason =
          c.id === 'slack' && !slackConfigured
            ? 'Configure Slack webhook above to enable this column.'
            : null;
        const checked = row.channels.includes(c.id);
        return (
          <td key={c.id} className="px-4 py-2">
            <label
              title={disabledReason ?? undefined}
              className={
                'inline-flex items-center gap-2 ' +
                (disabledReason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')
              }
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!!disabledReason || !canEdit || pending}
                onChange={() => toggle(c.id)}
              />
              <span className="font-mono text-[11px] text-ink-2">
                {checked ? 'on' : 'off'}
              </span>
            </label>
          </td>
        );
      })}
    </tr>
  );
}
