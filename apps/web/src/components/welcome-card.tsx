'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { Card } from './ui';
import { triggerRunAction } from './runs-actions';

const STORAGE_KEY = 'mergecrew:welcome-dismissed';
const DEMO_PROJECT_SLUG = 'demo-saas';

/**
 * First-visit welcome card on the Today page (#363, V2.af).
 *
 * Renders eagerly on SSR so first-visit users (and CI smokes that
 * curl the page) see the card without waiting for client-side state.
 * The mount effect reads localStorage and hides the card if the user
 * has dismissed it — that causes a brief flash on dismissed visits,
 * which we accept in exchange for a discoverable, server-rendered
 * marker.
 */
export function WelcomeCard({
  orgSlug,
  hasDemoProject = false,
}: {
  orgSlug: string;
  /**
   * True when the seeded demo project (\`demo-saas\`) is reachable in
   * this org. Gates the demo bullets + "Try a sample run" CTA so fresh
   * orgs without a seeded demo (self-hosters who set
   * \`MERGECREW_SEED_DEMO_PROJECT=0\`) don't render dead links.
   */
  hasDemoProject?: boolean;
}) {
  const [state, setState] = useState<'visible' | 'dismissed'>('visible');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) {
        setState('dismissed');
      }
    } catch {
      // localStorage can throw in restricted contexts (private mode +
      // certain browsers). Leave the card visible — the worst case is
      // a card that re-appears on reload, which is better than one
      // that never appears.
    }
  }, []);

  if (state !== 'visible') return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore; the next reload will just show it again.
    }
    setState('dismissed');
  };

  return (
    <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-700/40 dark:bg-sky-950/30">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <div className="font-medium">Welcome to mergecrew</div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            mergecrew runs an agentic development lifecycle against your repo on a daily cadence. Each run dispatches a planner → coder → reviewer chain and proposes a changeset for human approval.
          </p>
          {hasDemoProject && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-200">
              <li>
                <Link className="underline hover:text-sky-700 dark:hover:text-sky-300" href={`/orgs/${orgSlug}/projects/demo-saas`}>
                  Open the seeded demo project
                </Link>{' '}
                to see a completed multi-agent run, its three agent steps, and the resulting changeset.
              </li>
              <li>
                The{' '}
                <Link className="underline hover:text-sky-700 dark:hover:text-sky-300" href={`/orgs/${orgSlug}/projects/demo-saas/lifecycle`}>
                  Lifecycle
                </Link>{' '}
                page edits the YAML that defines agents + workflows for a project.
              </li>
            </ul>
          )}
          {hasDemoProject && (
            <form
              action={(fd) => startTransition(() => triggerRunAction(fd))}
              className="flex flex-wrap items-center gap-3"
            >
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="projectSlug" value={DEMO_PROJECT_SLUG} />
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center justify-center rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? 'Starting sample run…' : 'Try a sample run'}
              </button>
              <span className="text-xs text-zinc-600 dark:text-zinc-300">
                Triggers the seeded demo project ({DEMO_PROJECT_SLUG}) and opens the live timeline.
              </span>
            </form>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="self-start rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Dismiss welcome card"
        >
          Dismiss
        </button>
      </div>
    </Card>
  );
}
