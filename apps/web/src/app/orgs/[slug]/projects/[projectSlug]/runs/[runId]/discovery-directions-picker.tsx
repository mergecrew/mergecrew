'use client';

import { useTransition } from 'react';
import { Button, Card } from '@/components/ui';

export interface DiscoveryDirection {
  title: string;
  rationale: string;
  filesExpected: string[];
  effort: string;
}

/**
 * Discovery directions picker (#507). Shown on the run-detail page
 * when the planner ran in discovery mode (#492) and the project
 * doesn't yet have a queued or picked-up intent. Each direction
 * renders as a card with title / rationale / files-expected chips /
 * effort badge / "Pick this direction" primary button.
 *
 * Picking one fires the passed-in server action which (a) creates a
 * queued IntentInboxItem with the title + rationale as the body and
 * (b) triggers a fresh run. The action redirects to the new
 * run-detail page so the operator watches the chained run boot.
 */
export function DiscoveryDirectionsPicker({
  directions,
  action,
  picked,
}: {
  directions: DiscoveryDirection[];
  action: (formData: FormData) => Promise<void>;
  /**
   * When true, the picker renders as informational (no buttons). Used
   * when at least one intent already exists for the project — i.e. a
   * direction has been picked already, so we shouldn't re-prompt.
   */
  picked?: boolean;
}) {
  const [pending, startTransition] = useTransition();

  if (directions.length === 0) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50/40 dark:border-emerald-700/40 dark:bg-emerald-950/20">
      <div className="space-y-3">
        <div>
          <h2 className="font-medium">Pick a first task</h2>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {picked
              ? 'The planner suggested these directions on its discovery pass. A direction has already been picked — visit the project page to see the follow-up run.'
              : 'The planner explored your repo and suggested three candidate first runs. Pick one and mergecrew will start a fresh run with it as the goal.'}
          </p>
        </div>
        <ol className="space-y-3">
          {directions.map((d, i) => (
            <li
              key={`${i}-${d.title}`}
              className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-mono text-zinc-500">#{i + 1}</span>
                    <span className="font-medium">{d.title}</span>
                    {d.effort && <EffortBadge effort={d.effort} />}
                  </div>
                  {d.rationale && (
                    <p className="mt-1 text-zinc-700 dark:text-zinc-300">{d.rationale}</p>
                  )}
                  {d.filesExpected.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.filesExpected.map((p) => (
                        <code
                          key={p}
                          className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          {p}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                {!picked && (
                  <form
                    action={(fd) => startTransition(() => action(fd))}
                    className="shrink-0"
                  >
                    <input type="hidden" name="title" value={d.title} />
                    <input type="hidden" name="rationale" value={d.rationale} />
                    <Button variant="primary" type="submit" disabled={pending}>
                      {pending ? 'Starting…' : 'Pick this direction'}
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

function EffortBadge({ effort }: { effort: string }) {
  const normalized = effort.toLowerCase();
  const cls =
    normalized === 'small'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
      : normalized === 'large'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
        : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{effort}</span>
  );
}
