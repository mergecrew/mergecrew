'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Every weekday at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every day at 06:00', cron: '0 6 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes (testing)', cron: '*/15 * * * *' },
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ScheduleFormProps {
  initial: { cron: string; timezone: string; enabled: boolean; skipDates?: string[] } | null;
  canEdit: boolean;
  onSave: (input: {
    cron: string;
    timezone: string;
    enabled: boolean;
    skipDates: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function ScheduleForm({ initial, canEdit, onSave }: ScheduleFormProps) {
  const [cron, setCron] = useState(initial?.cron ?? '0 8 * * 1-5');
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'UTC');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [skipDatesRaw, setSkipDatesRaw] = useState((initial?.skipDates ?? []).join('\n'));
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const parseSkipDates = (raw: string): { ok: true; dates: string[] } | { ok: false; error: string } => {
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const line of lines) {
      if (!ISO_DATE_RE.test(line)) {
        return { ok: false, error: `"${line}" is not in YYYY-MM-DD format` };
      }
      const d = new Date(line + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) {
        return { ok: false, error: `"${line}" is not a valid date` };
      }
    }
    return { ok: true, dates: Array.from(new Set(lines)).sort() };
  };

  const submit = () => {
    setFeedback(null);
    const parsed = parseSkipDates(skipDatesRaw);
    if (!parsed.ok) {
      setFeedback({ kind: 'err', msg: parsed.error });
      return;
    }
    startTransition(async () => {
      const r = await onSave({
        cron: cron.trim(),
        timezone: timezone.trim(),
        enabled,
        skipDates: parsed.dates,
      });
      if (r.ok) {
        setFeedback({ kind: 'ok', msg: 'Saved.' });
        setSkipDatesRaw(parsed.dates.join('\n'));
      } else setFeedback({ kind: 'err', msg: r.error ?? 'Failed.' });
    });
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={!canEdit}
        />
        <span>
          Schedule enabled{' '}
          <span className="text-xs text-zinc-500">
            — when off, the project runs only via "Run now"
          </span>
        </span>
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Cron expression</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700 disabled:opacity-60"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 8 * * 1-5"
          disabled={!canEdit}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Standard 5-field cron. Evaluated in the timezone below.
        </span>
      </label>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.cron}
              type="button"
              onClick={() => setCron(p.cron)}
              className="rounded border px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Timezone</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700 disabled:opacity-60"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="UTC, America/Los_Angeles, Europe/Berlin, …"
          disabled={!canEdit}
        />
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Skip dates{' '}
          <span className="text-xs text-zinc-500">
            — one per line, YYYY-MM-DD. Holidays / merge freezes / etc. The scheduler
            checks today's date in the timezone above and silently skips when it matches.
          </span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700 disabled:opacity-60"
          value={skipDatesRaw}
          onChange={(e) => setSkipDatesRaw(e.target.value)}
          rows={4}
          placeholder={'2026-12-25\n2027-01-01'}
          disabled={!canEdit}
        />
      </label>

      {feedback && (
        <div
          className={
            'rounded p-2 text-xs ' +
            (feedback.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-900/20 dark:text-rose-300')
          }
        >
          {feedback.msg}
        </div>
      )}

      {canEdit && (
        <div>
          <Button variant="primary" disabled={pending} onClick={submit}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
