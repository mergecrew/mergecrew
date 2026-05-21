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
    'border p-5 transition-colors',
    status === 'active' && 'border-accent bg-accent-tint shadow-card',
    status === 'complete' && 'border-hair bg-paper',
    status === 'locked' && 'border-hair-2 bg-bg/60',
  );

  return (
    <li className={wrapperClass}>
      <div className="flex items-start gap-4">
        <div className="mt-1 shrink-0">
          {status === 'complete' ? (
            <span
              aria-label="complete"
              className="flex h-[26px] w-[26px] items-center justify-center bg-positive text-paper"
            >
              <Check className="h-[14px] w-[14px]" />
            </span>
          ) : status === 'active' ? (
            <span
              aria-label="active"
              className="flex h-[26px] w-[26px] items-center justify-center border-2 border-accent bg-paper font-mono text-[12px] font-semibold text-accent"
            >
              {index + 1}
            </span>
          ) : (
            <span
              aria-label="locked"
              className="flex h-[26px] w-[26px] items-center justify-center border border-hair bg-bg text-muted"
            >
              <Lock className="h-[13px] w-[13px]" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
              Step {index + 1}
            </span>
            <span
              className={clsx(
                'text-[15px] font-medium tracking-[-0.005em]',
                status === 'complete' && 'text-ink-3 line-through decoration-hair-strong',
                status === 'locked' && 'text-muted',
              )}
            >
              {label}
            </span>
          </div>
          {status === 'active' && description && (
            <p className="text-[13.5px] leading-[1.55] text-ink-2">{description}</p>
          )}
          {status === 'active' && children && <div className="pt-1">{children}</div>}
        </div>
      </div>
    </li>
  );
}
