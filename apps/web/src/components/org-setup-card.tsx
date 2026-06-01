'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card } from './ui';

const STORAGE_KEY = 'mergecrew:org-setup-card-dismissed';

interface SetupStep {
  key: string;
  label: string;
  status: 'complete' | 'pending';
  actionUrl: string;
}

/**
 * Single setup card on the Today page (#441) replacing the old pair
 * `WelcomeCard` + `OnboardingBanner` that competed for the same real
 * estate. Renders only while onboarding is incomplete; once every
 * step is checked off, the Today page becomes the Today page.
 *
 * Now renders the **per-step rows** inline (#847) instead of just a
 * counter, so operators can see *which* steps remain and jump
 * straight to the destination for each one. The wizard at
 * `/orgs/<slug>/onboarding` still hosts the inline forms for steps
 * that need them; the dashboard card is a triage + jump-off surface.
 *
 * Dismiss is per-localStorage, gated on any remaining pending steps
 * — if the operator dismisses then makes more progress (or new
 * steps appear), the same key keeps it hidden. #444 notes
 * server-side persistence as a future polish.
 */
export function OrgSetupCard({
  orgSlug,
  steps,
  demoProjectSlug,
}: {
  orgSlug: string;
  steps: SetupStep[];
  /**
   * Slug of the seeded demo project for this org, if one exists.
   * Gates the "Or revisit the demo project →" secondary link so
   * self-hosters who opted out of demo seeding don't see a dead link.
   */
  demoProjectSlug?: string | null;
}) {
  const [state, setState] = useState<'visible' | 'dismissed'>('visible');

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) {
        setState('dismissed');
      }
    } catch {
      // Restricted-context localStorage — leave visible.
    }
  }, []);

  const totalSteps = steps.length;
  const doneSteps = steps.filter((s) => s.status === 'complete').length;
  const pendingSteps = totalSteps - doneSteps;
  const nextPending = steps.find((s) => s.status === 'pending');

  if (state !== 'visible' || pendingSteps === 0) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setState('dismissed');
  };

  return (
    <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-700/40 dark:bg-sky-950/30">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Welcome to mergecrew</span>
            <span className="rounded-full bg-sky-200/70 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-800/60 dark:text-sky-100">
              {`${doneSteps} of ${totalSteps} done`}
            </span>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            mergecrew runs a planner → coder → reviewer chain on your repo each day and proposes
            changesets for approval. Each row below is a prerequisite — knock them off in order
            to get your first run.
          </p>
          <ol className="space-y-1.5 text-sm">
            {steps.map((step) => {
              const done = step.status === 'complete';
              return (
                <li
                  key={step.key}
                  className="flex items-center gap-2"
                >
                  <span
                    aria-hidden
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      done
                        ? 'bg-emerald-500 text-white'
                        : 'border border-sky-400/60 text-transparent'
                    }`}
                  >
                    {done ? '✓' : ''}
                  </span>
                  <span
                    className={
                      done
                        ? 'text-zinc-500 line-through dark:text-zinc-500'
                        : 'text-zinc-800 dark:text-zinc-100'
                    }
                  >
                    {step.label}
                  </span>
                  {!done && (
                    <Link
                      href={step.actionUrl}
                      className="ml-auto text-xs font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
                    >
                      Set up →
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              href={nextPending?.actionUrl ?? `/orgs/${orgSlug}/onboarding`}
              className="inline-flex items-center justify-center rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-700"
            >
              {nextPending ? `Continue setup → ${nextPending.label}` : 'Continue setup →'}
            </Link>
            {demoProjectSlug && (
              <Link
                href={`/orgs/${orgSlug}/projects/${demoProjectSlug}`}
                className="text-sm font-medium text-sky-700 underline hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100"
              >
                Or revisit the demo project →
              </Link>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="self-start rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Dismiss setup card"
        >
          Dismiss
        </button>
      </div>
    </Card>
  );
}
