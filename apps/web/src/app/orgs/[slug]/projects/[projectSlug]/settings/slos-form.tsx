'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import {
  createSloAction,
  updateSloAction,
  deleteSloAction,
  type SloListResponse,
  type SloMetric,
} from './slos-actions';

type SloRow = SloListResponse['items'][number];

const METRIC_LABELS: Record<SloMetric, { label: string; unit: string; help: string }> = {
  stepPassRate: {
    label: 'Step pass rate',
    unit: '%',
    help: 'Percent of agent steps that completed (vs failed) in the window.',
  },
  runFailureRate: {
    label: 'Run failure rate',
    unit: '%',
    help: 'Percent of daily runs that ended in `failed` status.',
  },
  p95StepMs: {
    label: 'p95 step latency',
    unit: 'ms',
    help: '95th percentile step duration in the window.',
  },
  dailyCostUsd: {
    label: 'Daily LLM cost',
    unit: 'USD',
    help: 'Average daily LLM spend in the window.',
  },
};

const STATE_TONE: Record<string, string> = {
  OK: 'text-positive-deep',
  AT_RISK: 'text-warn-deep',
  BREACHING: 'text-energy-deep',
  INSUFFICIENT_DATA: 'text-muted',
  DISABLED: 'text-muted',
};

export function SlosForm({
  slug,
  projectSlug,
  initial,
  canEdit,
}: {
  slug: string;
  projectSlug: string;
  initial: SloListResponse;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<SloRow[]>(initial.items);
  const [draftOpen, setDraftOpen] = useState(false);

  return (
    <div className="space-y-3">
      <Card className="p-0">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-muted">
            No SLOs yet. Add one to surface a health badge on the project list.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
              <tr className="border-b border-ink">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Metric</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Window</th>
                <th className="px-4 py-2 font-medium">State</th>
                {canEdit && <th className="px-4 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <SloRow
                  key={s.id}
                  slug={slug}
                  projectSlug={projectSlug}
                  row={s}
                  canEdit={canEdit}
                  onUpdate={(updated) =>
                    setItems((arr) =>
                      arr.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)),
                    )
                  }
                  onDelete={() =>
                    setItems((arr) => arr.filter((x) => x.id !== s.id))
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {canEdit && !draftOpen && (
        <button
          type="button"
          onClick={() => setDraftOpen(true)}
          className="border border-hair bg-paper px-3 py-2 font-mono text-[11px] text-ink hover:bg-bg"
        >
          + Add SLO
        </button>
      )}

      {canEdit && draftOpen && (
        <DraftRow
          slug={slug}
          projectSlug={projectSlug}
          onCreate={(created) => {
            setItems((arr) => [...arr, created]);
            setDraftOpen(false);
          }}
          onCancel={() => setDraftOpen(false)}
        />
      )}

      {!canEdit && (
        <p className="m-0 text-[12px] text-muted">Only operators can edit SLOs.</p>
      )}
    </div>
  );
}

function SloRow({
  slug,
  projectSlug,
  row,
  canEdit,
  onUpdate,
  onDelete,
}: {
  slug: string;
  projectSlug: string;
  row: SloRow;
  canEdit: boolean;
  onUpdate: (r: SloRow) => void;
  onDelete: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const meta = METRIC_LABELS[row.metric];

  const toggleEnabled = () => {
    if (!canEdit || pending) return;
    startTransition(async () => {
      const next = await updateSloAction(slug, projectSlug, row.id, {
        enabled: !row.enabled,
      });
      onUpdate(next);
    });
  };

  const remove = () => {
    if (!canEdit || pending) return;
    if (!confirm(`Delete SLO "${row.name}"?`)) return;
    startTransition(async () => {
      await deleteSloAction(slug, projectSlug, row.id);
      onDelete();
    });
  };

  return (
    <tr className="border-b border-hair-2 last:border-b-0">
      <td className="px-4 py-2">
        <div className="font-medium">{row.name}</div>
        {!row.enabled && (
          <div className="font-mono text-[10.5px] text-muted">disabled</div>
        )}
      </td>
      <td className="px-4 py-2 font-mono text-[11.5px] text-ink-2">
        {meta?.label ?? row.metric}
      </td>
      <td className="px-4 py-2 font-mono tabular-nums">
        {row.comparator === 'gte' ? '≥ ' : '≤ '}
        {row.threshold}
        {meta?.unit ? ` ${meta.unit}` : ''}
      </td>
      <td className="px-4 py-2 font-mono tabular-nums text-ink-2">
        {row.windowHours <= 24 ? `${row.windowHours}h` : `${Math.round(row.windowHours / 24)}d`}
      </td>
      <td className="px-4 py-2">
        <span
          className={
            'font-mono text-[11px] ' +
            (STATE_TONE[row.currentState] ?? 'text-muted')
          }
        >
          {row.currentState}
          {row.currentValue != null && row.enabled && (
            <span className="ml-2 text-ink-2">
              ({formatValue(row.metric, row.currentValue)})
            </span>
          )}
        </span>
      </td>
      {canEdit && (
        <td className="px-4 py-2 text-right">
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={pending}
            className="mr-3 font-mono text-[11px] text-ink-2 hover:text-ink"
          >
            {row.enabled ? 'disable' : 'enable'}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="font-mono text-[11px] text-energy-deep hover:underline"
          >
            delete
          </button>
        </td>
      )}
    </tr>
  );
}

function DraftRow({
  slug,
  projectSlug,
  onCreate,
  onCancel,
}: {
  slug: string;
  projectSlug: string;
  onCreate: (r: SloRow) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<SloMetric>('stepPassRate');
  const [comparator, setComparator] = useState<'gte' | 'lte'>('gte');
  const [threshold, setThreshold] = useState('95');
  const [windowHours, setWindowHours] = useState('24');
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setErr(null);
    const t = Number(threshold);
    const w = Number(windowHours);
    if (!name.trim()) {
      setErr('name is required');
      return;
    }
    if (!Number.isFinite(t)) {
      setErr('threshold must be a number');
      return;
    }
    if (!Number.isInteger(w) || w < 1 || w > 720) {
      setErr('window hours must be 1–720');
      return;
    }
    startTransition(async () => {
      try {
        const created = await createSloAction(slug, projectSlug, {
          name: name.trim(),
          metric,
          comparator,
          threshold: t,
          windowHours: w,
        });
        // The list endpoint annotates with currentState/currentValue;
        // a fresh row hasn't been evaluated yet — fill placeholders so
        // the row renders correctly until the next tick.
        onCreate({
          ...created,
          currentState: 'INSUFFICIENT_DATA',
          currentValue: null,
        });
      } catch (e) {
        setErr((e as Error)?.message ?? 'failed');
      }
    });
  };

  return (
    <Card className="p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Daily run pass rate"
            className="w-full border border-hair bg-paper px-2 py-1 text-[13px]"
          />
        </Field>
        <Field label="Metric">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as SloMetric)}
            className="w-full border border-hair bg-paper px-2 py-1 text-[13px]"
          >
            {Object.entries(METRIC_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Comparator">
          <select
            value={comparator}
            onChange={(e) => setComparator(e.target.value as 'gte' | 'lte')}
            className="w-full border border-hair bg-paper px-2 py-1 text-[13px]"
          >
            <option value="gte">≥ (at least)</option>
            <option value="lte">≤ (at most)</option>
          </select>
        </Field>
        <Field label={`Threshold (${METRIC_LABELS[metric]?.unit ?? ''})`}>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="w-full border border-hair bg-paper px-2 py-1 text-[13px] font-mono"
          />
        </Field>
        <Field label="Window (hours, 1–720)">
          <input
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
            className="w-full border border-hair bg-paper px-2 py-1 text-[13px] font-mono"
          />
        </Field>
      </div>
      <p className="mt-3 text-[12px] text-muted">{METRIC_LABELS[metric]?.help}</p>
      {err && (
        <p className="mt-3 font-mono text-[11.5px] text-energy-deep">{err}</p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] text-paper disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save SLO'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="border border-hair bg-paper px-3 py-1.5 font-mono text-[11px] text-ink-2 hover:bg-bg"
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatValue(metric: string, v: number): string {
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
