'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
 * Project Lifecycle stock-template picker (#394, #480).
 *
 * Each apply overwrites the project's current lifecycle YAML — a new
 * version snapshot is created server-side (carrying the template id
 * as its `name`), so this is reversible via the versions list, but a
 * confirmation step prevents misclicks.
 *
 * `activeTemplateId` highlights the currently-applied template so the
 * operator sees what's live. `Apply & customize` applies the template
 * then scrolls to the YAML editor below (#editor anchor); plain Apply
 * stays put — both go through the same server-side path.
 */
export function StockTemplatePicker({
  scope,
  templates,
  activeTemplateId,
}: {
  scope: Extract<LifecycleScope, { kind: 'project' }>;
  templates: StockTemplateSummary[];
  activeTemplateId?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  function apply(id: string, customize = false) {
    setError(null);
    setAppliedId(null);
    startTransition(async () => {
      try {
        await applyStockTemplateAction(scope, id);
        setAppliedId(id);
        setConfirmId(null);
        if (customize && typeof window !== 'undefined') {
          // The YAML editor is the next Card on the page. Scroll into
          // view so "Apply & customize" feels like a single action.
          const editor = document.getElementById('lifecycle-yaml-editor');
          editor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        router.refresh();
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
          const isActive = activeTemplateId === t.id;
          return (
            <li
              key={t.id}
              className={clsx(
                'flex flex-col border bg-paper p-4 transition-colors',
                isConfirming
                  ? 'border-warn'
                  : isActive
                    ? 'border-positive'
                    : 'border-hair',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="font-mono text-xs text-zinc-500">{t.id}</span>
                    {isActive && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                        Active
                      </span>
                    )}
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
                      variant="secondary"
                      disabled={pending}
                      onClick={() => apply(t.id, true)}
                    >
                      Apply &amp; customize
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
                    variant={isActive ? 'ghost' : 'secondary'}
                    disabled={pending || isActive}
                    onClick={() => setConfirmId(t.id)}
                  >
                    {isActive ? 'Currently active' : 'Apply template'}
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
