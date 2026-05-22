'use client';

import { useMemo, useState, useTransition } from 'react';
import { parseExpression } from 'cron-parser';
import { Button } from '@/components/ui';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Schedule editor (#271). Structured pickers for frequency / time /
 * timezone / skip dates; a Custom-cron fallback keeps the textarea
 * for power users. Live "next 3 fires" preview computed in the
 * browser via cron-parser (same lib worker-cron uses), so the operator
 * sees what their config actually means before saving.
 */

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

interface Decoded {
  frequency: Frequency;
  time: string; // "HH:MM" — only when frequency != hourly / custom
  weekday: number; // 0..6 (Sun..Sat) — only for weekly
}

const TZ_PRESETS = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function decodeCron(cron: string): Decoded {
  // Best-effort recognition of the limited shapes the picker generates.
  // Anything else collapses to 'custom' so the textarea takes over.
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', time: '08:00', weekday: 1 };
  const [m, h, dom, mon, dow] = parts;
  const isHH = /^[0-9]+$/.test(h) && Number(h) >= 0 && Number(h) <= 23;
  const isMM = /^[0-9]+$/.test(m) && Number(m) >= 0 && Number(m) <= 59;
  const hhmm = isHH && isMM ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : '08:00';
  if (
    m === '0' &&
    /^\*\/?[0-9]*$/.test(h) &&
    h.includes('*') &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return { frequency: 'hourly', time: '00:00', weekday: 1 };
  }
  if (isMM && isHH && dom === '*' && mon === '*' && dow === '*') {
    return { frequency: 'daily', time: hhmm, weekday: 1 };
  }
  if (isMM && isHH && dom === '*' && mon === '*' && dow === '1-5') {
    return { frequency: 'weekdays', time: hhmm, weekday: 1 };
  }
  if (isMM && isHH && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return { frequency: 'weekly', time: hhmm, weekday: Number(dow) };
  }
  return { frequency: 'custom', time: hhmm, weekday: 1 };
}

function encodeCron(d: Decoded, customCron: string): string {
  const [h, m] = d.time.split(':').map((s) => Number(s));
  if (d.frequency === 'daily') return `${m} ${h} * * *`;
  if (d.frequency === 'weekdays') return `${m} ${h} * * 1-5`;
  if (d.frequency === 'weekly') return `${m} ${h} * * ${d.weekday}`;
  if (d.frequency === 'hourly') return `0 * * * *`;
  return customCron;
}

function previewNextFires(cron: string, timezone: string): string[] {
  try {
    const it = parseExpression(cron, { tz: timezone });
    return [it.next(), it.next(), it.next()].map((d) => d.toDate().toLocaleString());
  } catch {
    return [];
  }
}

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
  const initialCron = initial?.cron ?? '0 8 * * 1-5';
  const decoded = useMemo(() => decodeCron(initialCron), [initialCron]);

  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [frequency, setFrequency] = useState<Frequency>(decoded.frequency);
  const [time, setTime] = useState(decoded.time);
  const [weekday, setWeekday] = useState(decoded.weekday);
  const [customCron, setCustomCron] = useState(initialCron);
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'UTC');
  const [skipDates, setSkipDates] = useState<string[]>(initial?.skipDates ?? []);
  const [skipDraft, setSkipDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const cronExpression = useMemo(
    () => encodeCron({ frequency, time, weekday }, customCron),
    [frequency, time, weekday, customCron],
  );
  const preview = useMemo(
    () => previewNextFires(cronExpression, timezone),
    [cronExpression, timezone],
  );

  const addSkipDate = () => {
    const t = skipDraft.trim();
    if (!t) return;
    if (!ISO_DATE_RE.test(t)) {
      setFeedback({ kind: 'err', msg: `"${t}" is not in YYYY-MM-DD format` });
      return;
    }
    if (Number.isNaN(new Date(`${t}T00:00:00Z`).getTime())) {
      setFeedback({ kind: 'err', msg: `"${t}" is not a valid date` });
      return;
    }
    setSkipDates((prev) => Array.from(new Set([...prev, t])).sort());
    setSkipDraft('');
    setFeedback(null);
  };

  const removeSkipDate = (d: string) => {
    setSkipDates((prev) => prev.filter((x) => x !== d));
  };

  const submit = () => {
    setFeedback(null);
    if (preview.length === 0) {
      setFeedback({ kind: 'err', msg: 'Cron expression is invalid in this timezone.' });
      return;
    }
    startTransition(async () => {
      const r = await onSave({
        cron: cronExpression,
        timezone,
        enabled,
        skipDates,
      });
      if (r.ok) setFeedback({ kind: 'ok', msg: 'Saved.' });
      else setFeedback({ kind: 'err', msg: r.error ?? 'Failed.' });
    });
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={!canEdit}
        />
        <span>
          Schedule enabled{' '}
          <span className="text-xs text-muted">
            — when off, the project runs only via "Run now"
          </span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-ink-2">Frequency</span>
          <select
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
            disabled={!canEdit}
          >
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="daily">Every day</option>
            <option value="weekly">Once a week</option>
            <option value="hourly">Every hour</option>
            <option value="custom">Custom cron</option>
          </select>
        </label>

        {frequency !== 'hourly' && frequency !== 'custom' && (
          <label className="text-sm">
            <span className="block text-ink-2">Time of day</span>
            <input
              type="time"
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60"
              value={time}
              onChange={(e) => setTime(e.target.value || '08:00')}
              disabled={!canEdit}
            />
          </label>
        )}

        {frequency === 'weekly' && (
          <label className="text-sm">
            <span className="block text-ink-2">Day of week</span>
            <select
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60"
              value={String(weekday)}
              onChange={(e) => setWeekday(Number(e.target.value))}
              disabled={!canEdit}
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {frequency === 'custom' && (
        <label className="block text-sm">
          <span className="block text-ink-2">Cron expression</span>
          <input
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono disabled:opacity-60"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 8 * * 1-5"
            disabled={!canEdit}
          />
          <span className="mt-1 block text-xs text-muted">
            Standard 5-field cron. Evaluated in the timezone below.
          </span>
        </label>
      )}

      <label className="block text-sm">
        <span className="block text-ink-2">Timezone</span>
        <input
          list="tz-presets"
          className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono disabled:opacity-60"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="UTC"
          disabled={!canEdit}
        />
        <datalist id="tz-presets">
          {TZ_PRESETS.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </label>

      <div className="rounded border bg-bg p-2 text-xs /50">
        <div className="font-medium text-zinc-700 dark:text-muted-2">Next 3 scheduled fires</div>
        {preview.length === 0 ? (
          <div className="mt-1 text-rose-700 dark:text-rose-300">
            Invalid cron expression or unknown timezone.
          </div>
        ) : (
          <ul className="mt-1 space-y-0.5 font-mono">
            {preview.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="mt-1 font-mono text-[10px] text-muted">cron: {cronExpression}</div>
      </div>

      <div>
        <div className="text-sm text-ink-2">
          Skip dates{' '}
          <span className="text-xs text-muted">
            — holidays / freezes. Scheduler checks today's date in the timezone above and silently
            skips when it matches.
          </span>
        </div>
        <div className="mt-1 flex gap-2">
          <input
            type="date"
            className="flex-1 border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60"
            value={skipDraft}
            onChange={(e) => setSkipDraft(e.target.value)}
            disabled={!canEdit}
          />
          <Button onClick={addSkipDate} disabled={!canEdit || !skipDraft} variant="secondary">
            Add
          </Button>
        </div>
        {skipDates.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {skipDates.map((d) => (
              <li
                key={d}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-mono "
              >
                {d}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeSkipDate(d)}
                    className="ml-1 text-muted hover:text-rose-600"
                    aria-label={`Remove ${d}`}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

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
