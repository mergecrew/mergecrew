'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { updateProjectAction } from './settings-actions';

interface Props {
  slug: string;
  projectSlug: string;
  initialMaxFiles: number;
  initialMaxLines: number;
  initialDeniedPaths: string[];
  canEdit: boolean;
}

export function BlastRadiusForm({
  slug,
  projectSlug,
  initialMaxFiles,
  initialMaxLines,
  initialDeniedPaths,
  canEdit,
}: Props) {
  const [maxFiles, setMaxFiles] = useState(String(initialMaxFiles));
  const [maxLines, setMaxLines] = useState(String(initialMaxLines));
  const [deniedPaths, setDeniedPaths] = useState<string[]>(initialDeniedPaths);
  const [pickerValue, setPickerValue] = useState('');
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    Number(maxFiles) !== initialMaxFiles ||
    Number(maxLines) !== initialMaxLines ||
    deniedPaths.length !== initialDeniedPaths.length ||
    deniedPaths.some((p, i) => p !== initialDeniedPaths[i]);

  const addGlob = () => {
    const trimmed = pickerValue.trim();
    if (!trimmed || deniedPaths.includes(trimmed)) return;
    setDeniedPaths((prev) => [...prev, trimmed]);
    setPickerValue('');
  };

  const removeGlob = (i: number) => {
    setDeniedPaths((prev) => prev.filter((_, idx) => idx !== i));
  };

  const onSave = () => {
    setError(null);
    const filesNum = Number(maxFiles);
    const linesNum = Number(maxLines);
    if (!Number.isInteger(filesNum) || filesNum < 1) {
      setError('Max files must be a positive integer.');
      return;
    }
    if (!Number.isInteger(linesNum) || linesNum < 1) {
      setError('Max lines must be a positive integer.');
      return;
    }
    startTransition(async () => {
      try {
        await updateProjectAction(slug, projectSlug, {
          maxFilesChanged: filesNum,
          maxLinesChanged: linesNum,
          deniedPaths,
        });
        setSavedAt(new Date().toLocaleTimeString());
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Hard ceilings the runner applies after the agent commits but before <code>git push</code>.
        A changeset over the cap or matching a deny-glob is marked <code>blocked</code> with the
        breakdown; nothing reaches the remote.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Max files changed</span>
          <input
            type="number"
            min="1"
            step="1"
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            value={maxFiles}
            onChange={(e) => setMaxFiles(e.target.value)}
            disabled={!canEdit || pending}
          />
        </label>
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Max lines changed (+/-)</span>
          <input
            type="number"
            min="1"
            step="1"
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            value={maxLines}
            onChange={(e) => setMaxLines(e.target.value)}
            disabled={!canEdit || pending}
          />
        </label>
      </div>

      <div>
        <div className="text-sm text-zinc-600 dark:text-zinc-400">
          Denied path globs{' '}
          <span className="text-xs text-zinc-400">
            — any changeset that touches one of these gets blocked
          </span>
        </div>
        {deniedPaths.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">
            No deny patterns — every path is allowed. (Strongly recommend keeping at least the
            secret-shaped globs.)
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1">
            {deniedPaths.map((p, i) => (
              <li
                key={p + i}
                className="flex items-center gap-1 rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <span>{p}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="rounded px-1 text-zinc-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/30 dark:hover:text-rose-300"
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
              className="flex-1 rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
              placeholder="e.g. **/migrations/**"
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
        <p className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        {canEdit ? (
          <>
            <Button variant="primary" onClick={onSave} disabled={!dirty || pending}>
              Save
            </Button>
            {savedAt && <span className="text-xs text-zinc-500">Saved at {savedAt}.</span>}
          </>
        ) : (
          <p className="text-xs text-zinc-500">Only operators can change this.</p>
        )}
        <span className="ml-auto" />
        <a
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/10-blast-radius.md"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Tuning guide →
        </a>
      </div>
    </div>
  );
}
