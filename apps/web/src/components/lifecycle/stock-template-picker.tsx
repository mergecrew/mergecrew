'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui';
import { applyStockTemplateAction } from './lifecycle-actions';
import type { LifecycleScope } from './scope';

export interface StockTemplateSummary {
  id: string;
  name: string;
  description: string;
  stack: string[];
}

/**
 * Project Lifecycle stock-template picker (#394, V2.ai).
 *
 * Each apply overwrites the project's current lifecycle YAML — a new
 * version snapshot is created server-side, so this is reversible via
 * the versions list, but a confirmation step prevents misclicks.
 */
export function StockTemplatePicker({
  scope,
  templates,
}: {
  scope: Extract<LifecycleScope, { kind: 'project' }>;
  templates: StockTemplateSummary[];
}) {
  const [pending, startTransition] = useTransition();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  function apply(id: string) {
    setError(null);
    setAppliedId(null);
    startTransition(async () => {
      try {
        await applyStockTemplateAction(scope, id);
        setAppliedId(id);
        setConfirmId(null);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      }
    });
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}
      {appliedId && (
        <div className="rounded bg-green-50 p-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300">
          Template <span className="font-medium">{appliedId}</span> applied as a new lifecycle version.
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => {
          const isConfirming = confirmId === t.id;
          return (
            <li
              key={t.id}
              className={clsx(
                'flex flex-col rounded-lg border bg-[rgb(var(--card))] p-4 shadow-sm transition-colors',
                isConfirming
                  ? 'border-amber-400 dark:border-amber-600'
                  : 'border-zinc-200 dark:border-zinc-700',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="font-mono text-xs text-zinc-500">{t.id}</span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.stack.map((s) => (
                      <span
                        key={s}
                        className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                {isConfirming ? (
                  <>
                    <span className="mr-auto text-xs text-amber-700 dark:text-amber-300">
                      Replaces the current lifecycle. A new version is saved.
                    </span>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setConfirmId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={pending}
                      onClick={() => apply(t.id)}
                    >
                      {pending ? 'Applying…' : 'Confirm apply'}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => setConfirmId(t.id)}
                  >
                    Apply template
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
