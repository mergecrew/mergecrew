import Link from 'next/link';
import { Card } from './ui';
import { relativeTime } from '@/lib/format';

export interface OnboardingChecklistProps {
  orgSlug: string;
  projectSlug: string;
  hasRepo: boolean;
  hasDevTarget: boolean;
  hasLifecycle: boolean;
  hasCompletedRun: boolean;
  lastSkippedAt: string | null;
}

/**
 * Shown on the project overview while onboarding isn't complete (#269).
 * Replaces the V2.x paused banner: same data, with explicit punch-list
 * items so a new operator sees what's left rather than just "paused."
 *
 * Returns null once all five items are checked; the dashboard tiles
 * take over from there.
 */
export function OnboardingChecklist(props: OnboardingChecklistProps) {
  const items = buildItems(props);
  const remaining = items.filter((i) => !i.done).length;
  if (remaining === 0) return null;

  return (
    <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-medium text-amber-900 dark:text-amber-100">
            Finish setting up this project
          </h2>
          <p className="mt-0.5 text-sm text-amber-800/80 dark:text-amber-200/70">
            {items.length - remaining} of {items.length} steps complete · runs stay disabled
            until everything is checked.
          </p>
        </div>
        {props.lastSkippedAt && (
          <p className="text-xs text-amber-800/70 dark:text-amber-200/60">
            Scheduler last skipped this project {relativeTime(props.lastSkippedAt)}.
          </p>
        )}
      </div>

      <ul className="mt-3 space-y-1.5">
        {items.map((item) => (
          <li key={item.title} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className={
                item.done
                  ? 'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white'
                  : 'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-amber-500/60'
              }
            >
              {item.done ? '✓' : ''}
            </span>
            <div className="min-w-0 flex-1">
              <div className={item.done ? 'text-amber-900/70 line-through dark:text-amber-100/60' : 'font-medium text-amber-900 dark:text-amber-100'}>
                {item.title}
              </div>
              {!item.done && item.href && (
                <Link
                  href={item.href}
                  className="text-xs text-amber-900 underline decoration-dotted hover:opacity-80 dark:text-amber-200"
                >
                  {item.cta}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface Item {
  title: string;
  done: boolean;
  href?: string;
  cta?: string;
}

function buildItems(props: OnboardingChecklistProps): Item[] {
  const settings = `/orgs/${props.orgSlug}/projects/${props.projectSlug}/settings`;
  const lifecycle = `/orgs/${props.orgSlug}/projects/${props.projectSlug}/lifecycle`;
  return [
    { title: 'Project created', done: true },
    {
      title: 'GitHub repository connected',
      done: props.hasRepo,
      href: settings,
      cta: 'Open Settings → Integrations',
    },
    {
      title: 'Dev deploy target configured',
      done: props.hasDevTarget,
      href: settings,
      cta: 'Open Settings → Deploy targets',
    },
    {
      title: 'Lifecycle saved',
      done: props.hasLifecycle,
      href: lifecycle,
      cta: 'Open Lifecycle editor',
    },
    {
      title: 'First run completed',
      done: props.hasCompletedRun,
      href: undefined,
      cta: undefined,
    },
  ];
}
