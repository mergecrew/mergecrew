'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

interface Rule {
  name: string;
  pathPatterns: string[];
  maxFilesChanged?: number;
  maxLinesChanged?: number;
  requireDocsOnly?: boolean;
  requirePackageJsonPatchOnly?: boolean;
}

type SaveResult = { ok: true } | { ok: false; error: string };

const TEMPLATES: Array<{ label: string; rule: Rule }> = [
  {
    label: 'Docs-only',
    rule: {
      name: 'docs-only',
      pathPatterns: ['**/*.md', '**/*.mdx'],
      requireDocsOnly: true,
      maxFilesChanged: 10,
    },
  },
  {
    label: 'Dep patch bumps',
    rule: {
      name: 'dep-patch-bump',
      pathPatterns: ['**/package.json', '**/pnpm-lock.yaml'],
      requirePackageJsonPatchOnly: true,
      maxFilesChanged: 5,
    },
  },
];

/**
 * Edits the project's auto-promote rules in-place client-side, then ships
 * the whole array to the server in one PUT. Server-side validation rejects
 * malformed rules and surfaces the first error message inline.
 */
export function AutoPromoteEditor({
  initialRules,
  canEdit,
  onSave,
}: {
  initialRules: Rule[];
  canEdit: boolean;
  onSave: (rules: Rule[]) => Promise<SaveResult>;
}) {
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function update(i: number, patch: Partial<Rule>) {
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function remove(i: number) {
    setRules((rs) => rs.filter((_, j) => j !== i));
  }

  function add(template?: Rule) {
    setRules((rs) => [
      ...rs,
      template ?? {
        name: `rule-${rs.length + 1}`,
        pathPatterns: ['**/*'],
      },
    ]);
  }

  function commit() {
    setError(null);
    startTransition(async () => {
      const r = await onSave(rules);
      if (r.ok) {
        setSavedAt(Date.now());
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 && (
        <p className="text-sm text-zinc-500">
          No rules configured. Every changeset goes through the manual approval gate.
        </p>
      )}
      <ul className="space-y-3">
        {rules.map((r, i) => (
          <li
            key={i}
            className="space-y-2 rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800"
          >
            <div className="flex items-baseline gap-2">
              <input
                value={r.name}
                disabled={!canEdit}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="rule name"
                className="flex-1 rounded border px-2 py-1 font-medium dark:bg-zinc-900 dark:border-zinc-700"
              />
              {canEdit && (
                <Button type="button" variant="destructive" onClick={() => remove(i)}>
                  Remove
                </Button>
              )}
            </div>
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">Path patterns (one per line)</span>
              <textarea
                value={r.pathPatterns.join('\n')}
                disabled={!canEdit}
                onChange={(e) =>
                  update(i, {
                    pathPatterns: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                rows={3}
                className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-zinc-600 dark:text-zinc-400">Max files</span>
                <input
                  type="number"
                  min="1"
                  value={r.maxFilesChanged ?? ''}
                  disabled={!canEdit}
                  onChange={(e) =>
                    update(i, {
                      maxFilesChanged: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                  className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
                />
              </label>
              <label className="block">
                <span className="text-zinc-600 dark:text-zinc-400">Max lines</span>
                <input
                  type="number"
                  min="1"
                  value={r.maxLinesChanged ?? ''}
                  disabled={!canEdit}
                  onChange={(e) =>
                    update(i, {
                      maxLinesChanged: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                  className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!!r.requireDocsOnly}
                  disabled={!canEdit}
                  onChange={(e) => update(i, { requireDocsOnly: e.target.checked })}
                />
                docs-only
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!!r.requirePackageJsonPatchOnly}
                  disabled={!canEdit}
                  onChange={(e) => update(i, { requirePackageJsonPatchOnly: e.target.checked })}
                />
                package patch-bumps only
              </label>
            </div>
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="flex flex-wrap gap-2 border-t pt-3 dark:border-zinc-800">
          <Button type="button" variant="secondary" onClick={() => add()}>
            + Empty rule
          </Button>
          {TEMPLATES.map((t) => (
            <Button
              key={t.label}
              type="button"
              variant="ghost"
              onClick={() => add({ ...t.rule })}
            >
              + {t.label}
            </Button>
          ))}
          <span className="flex-1" />
          <Button type="button" variant="primary" disabled={pending} onClick={commit}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {savedAt && !error && <p className="text-xs text-zinc-500">Saved.</p>}
    </div>
  );
}
