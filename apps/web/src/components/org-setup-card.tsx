'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card } from './ui';

const STORAGE_KEY = 'mergecrew:org-setup-card-dismissed';

/**
 * Single setup card on the Today page (#441) replacing the old pair
 * `WelcomeCard` + `OnboardingBanner` that competed for the same real
 * estate. Renders only while onboarding is incomplete; once the wizard
 * is fully checked off, the Today page becomes the Today page.
 *
 * Dismiss is per-localStorage, but the card itself is gated on
 * `pendingSteps > 0` — if the operator dismisses then makes more
 * progress (or fewer steps), the same key keeps it hidden. That's the
 * usual welcome-card pattern; #444's tracking notes server-side
 * persistence as a future polish.
 */
export function OrgSetupCard({
  orgSlug,
  totalSteps,
  pendingSteps,
  demoProjectSlug,
}: {
  orgSlug: string;
  totalSteps: number;
  pendingSteps: number;
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

  if (state !== 'visible' || pendingSteps === 0) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setState('dismissed');
  };

  const doneSteps = totalSteps - pendingSteps;

  return (
    <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-700/40 dark:bg-sky-950/30">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Welcome to mergecrew</span>
            <span className="rounded-full bg-sky-200/70 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-800/60 dark:text-sky-100">
              {doneSteps} of {totalSteps} done
            </span>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            mergecrew runs a planner → coder → reviewer chain on your repo each day and proposes
            changesets for approval. Connect an LLM, a repo, and a dev deploy target to trigger
            your first real run.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/orgs/${orgSlug}/onboarding`}
              className="inline-flex items-center justify-center rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-700"
            >
              Continue setup →
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
