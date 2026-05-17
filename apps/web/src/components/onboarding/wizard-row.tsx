import { type ReactNode } from 'react';
import { Check, Circle, Lock } from 'lucide-react';
import clsx from 'clsx';

export type WizardRowStatus = 'complete' | 'active' | 'locked';

/**
 * Row chrome for the inline onboarding wizard (#455). Three visual
 * variants share the same outer shape so the page reads as a single
 * checklist:
 *
 *   - `complete`  — collapsed, check icon, strikethrough label.
 *   - `active`    — expanded, info paragraph + form slot below.
 *   - `locked`    — collapsed, lock icon, greyed label.
 *
 * `children` only renders for the active variant. Step labels are
 * rendered server-side so the smoke greps for "Add an LLM provider"
 * etc. match regardless of which step the user is currently on.
 */
export function WizardRow({
  index,
  label,
  status,
  description,
  children,
}: {
  index: number;
  label: string;
  status: WizardRowStatus;
  description?: string;
  children?: ReactNode;
}) {
  const wrapperClass = clsx(
    'rounded-lg border p-4 shadow-sm transition-colors',
    status === 'active' && 'border-sky-400 bg-sky-50/60 dark:border-sky-600 dark:bg-sky-950/30',
    status === 'complete' &&
      'border-zinc-200 bg-[rgb(var(--card))] opacity-75 dark:border-zinc-700',
    status === 'locked' &&
      'border-zinc-200 bg-zinc-50/60 opacity-60 dark:border-zinc-800 dark:bg-zinc-900/30',
  );

  return (
    <li className={wrapperClass}>
      <div className="flex items-start gap-4">
        <div className="mt-0.5 shrink-0">
          {status === 'complete' ? (
            <Check
              className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
              aria-label="complete"
            />
          ) : status === 'active' ? (
            <Circle
              className="h-5 w-5 text-sky-600 dark:text-sky-400"
              aria-label="active"
            />
          ) : (
            <Lock
              className="h-5 w-5 text-zinc-400 dark:text-zinc-500"
              aria-label="locked"
            />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div
            className={clsx(
              'font-medium',
              status === 'complete' && 'line-through decoration-zinc-300 dark:decoration-zinc-600',
              status === 'locked' && 'text-zinc-500 dark:text-zinc-400',
            )}
          >
            {`Step ${index + 1} · ${label}`}
          </div>
          {status === 'active' && description && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
          )}
          {status === 'active' && children && <div>{children}</div>}
        </div>
      </div>
    </li>
  );
}
