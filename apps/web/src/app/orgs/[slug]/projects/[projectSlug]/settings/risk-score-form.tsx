'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { updateProjectAction } from './settings-actions';

interface Props {
  slug: string;
  projectSlug: string;
  initialThreshold: number;
  initialSensitivePaths: string[];
  canEdit: boolean;
}

export function RiskScoreForm({
  slug,
  projectSlug,
  initialThreshold,
  initialSensitivePaths,
  canEdit,
}: Props) {
  const [threshold, setThreshold] = useState(String(initialThreshold));
  const [paths, setPaths] = useState<string[]>(initialSensitivePaths);
  const [pickerValue, setPickerValue] = useState('');
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    Number(threshold) !== initialThreshold ||
    paths.length !== initialSensitivePaths.length ||
    paths.some((p, i) => p !== initialSensitivePaths[i]);

  const addGlob = () => {
    const trimmed = pickerValue.trim();
    if (!trimmed || paths.includes(trimmed)) return;
    setPaths((prev) => [...prev, trimmed]);
    setPickerValue('');
  };

  const removeGlob = (i: number) => {
    setPaths((prev) => prev.filter((_, idx) => idx !== i));
  };

  const onSave = () => {
    setError(null);
    const threshNum = Number(threshold);
    if (!Number.isInteger(threshNum) || threshNum < 0) {
      setError('Threshold must be a non-negative integer.');
      return;
    }
    startTransition(async () => {
      try {
        await updateProjectAction(slug, projectSlug, {
          autoMergeThreshold: threshNum,
          sensitivePaths: paths,
        });
        setSavedAt(new Date().toLocaleTimeString());
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        After a changeset opens its PR, the runner scores it as{' '}
        <code>filesChanged + linesChanged × 0.1 + sensitiveHits × 10</code>. Anything strictly above
        the threshold lands in the inbox as <code>risk_score_high</code> and is held back from
        auto-promote.
      </p>

      <label className="block text-sm">
        <span className="block text-ink-2">Threshold</span>
        <input
          type="number"
          min="0"
          step="1"
          className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] "
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          disabled={!canEdit || pending}
        />
        <span className="mt-1 block text-xs text-muted">
          Default 50: e.g. 50 files OR 500 LOC OR 5 sensitive-path hits each trip the gate alone.
        </span>
      </label>

      <div>
        <div className="text-sm text-ink-2">
          Sensitive path globs{' '}
          <span className="text-xs text-muted-2">— each match adds 10 to the score</span>
        </div>
        {paths.length === 0 ? (
          <p className="mt-1 text-xs text-muted">
            No sensitive paths — every file counts equally toward the score.
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1">
            {paths.map((p, i) => (
              <li
                key={p + i}
                className="flex items-center gap-1 rounded border border-zinc-300 bg-bg px-2 py-0.5 font-mono text-xs "
              >
                <span>{p}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="rounded px-1 text-muted hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/30 dark:hover:text-rose-300"
                    onClick={() => removeGlob(i)}
                    aria-label={`Remove ${p}`}
                    disabled={pending}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="mt-2 flex gap-2">
            <input
              className="flex-1 border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono text-xs "
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
              placeholder="e.g. **/auth/**"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addGlob();
                }
              }}
              disabled={pending}
            />
            <Button variant="secondary" onClick={addGlob} disabled={!pickerValue.trim() || pending}>
              Add
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        {canEdit ? (
          <>
            <Button variant="primary" onClick={onSave} disabled={!dirty || pending}>
              Save
            </Button>
            {savedAt && <span className="text-xs text-muted">Saved at {savedAt}.</span>}
          </>
        ) : (
          <p className="text-xs text-muted">Only operators can change this.</p>
        )}
        <span className="ml-auto" />
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/11-risk-score-gate.md"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted text-accent underline-offset-[3px] hover:underline hover:text-zinc-700 dark:hover:text-muted-2"
        >
          Tuning guide →
        </a>
      </div>
    </div>
  );
}
