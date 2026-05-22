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
    <Card className="border-positive bg-positive-soft">
      <div className="space-y-3">
        <div>
          <h2 className="font-medium">Pick a first task</h2>
          <p className="text-sm text-ink-2">
            {picked
              ? 'The planner suggested these directions on its discovery pass. A direction has already been picked — visit the project page to see the follow-up run.'
              : 'The planner explored your repo and suggested three candidate first runs. Pick one and mergecrew will start a fresh run with it as the goal.'}
          </p>
        </div>
        <ol className="space-y-3">
          {directions.map((d, i) => (
            <li key={`${i}-${d.title}`} className="border border-hair bg-paper p-3 text-sm ">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-mono text-muted">#{i + 1}</span>
                    <span className="font-medium">{d.title}</span>
                    {d.effort && <EffortBadge effort={d.effort} />}
                  </div>
                  {d.rationale && <p className="mt-1 text-ink-2">{d.rationale}</p>}
                  {d.filesExpected.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.filesExpected.map((p) => (
                        <code
                          key={p}
                          className="bg-bg border border-hair px-[8px] py-[2px] text-[11px] text-ink-2"
                        >
                          {p}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                {!picked && (
                  <form action={(fd) => startTransition(() => action(fd))} className="shrink-0">
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
      ? 'bg-positive-soft text-positive-deep'
      : normalized === 'large'
        ? 'bg-warn/40 text-ink'
        : 'bg-bg text-ink-2 border border-hair';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{effort}</span>;
}
