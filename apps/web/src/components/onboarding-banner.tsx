'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card } from './ui';

const STORAGE_KEY = 'mergecrew:onboarding-banner-dismissed';

/**
 * Today-page banner that points at the onboarding wizard (#384,
 * V2.ah). Shown when the org has incomplete setup steps. Dismissible
 * via its own localStorage key — operators can hide it without losing
 * track of their progress (the wizard itself stays reachable from
 * direct URL or any future Settings link).
 *
 * Server-rendered eagerly (matches the welcome-card + demo-banner
 * pattern from #365 / #374). State + step counts come from the server
 * via props so the visible markup is part of SSR — smokes can grep
 * for it, and the count never flashes from "0 done" to "N done" on
 * hydration.
 */
export function OnboardingBanner({
  orgSlug,
  totalSteps,
  pendingSteps,
}: {
  orgSlug: string;
  totalSteps: number;
  pendingSteps: number;
}) {
  const [state, setState] = useState<'visible' | 'dismissed'>('visible');

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) {
        setState('dismissed');
      }
    } catch {
      // restricted-context localStorage — leave visible; better than
      // an undismissable banner that vanishes for nobody.
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
        <div className="space-y-1">
          <div className="font-medium">
            Finish setting up your org
            <span className="ml-2 rounded-full bg-sky-200/70 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-800/60 dark:text-sky-100">
              {doneSteps} of {totalSteps} done
            </span>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Connect an LLM provider, create a project, and wire it to a repo + deploy target before triggering your first real run.
          </p>
          <Link
            className="inline-block text-sm font-medium text-sky-700 underline hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100"
            href={`/orgs/${orgSlug}/onboarding`}
          >
            Open the setup wizard →
          </Link>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="self-start rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Dismiss onboarding banner"
        >
          Dismiss
        </button>
      </div>
    </Card>
  );
}
