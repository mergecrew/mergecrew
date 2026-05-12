'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card } from './ui';

const STORAGE_KEY = 'mergecrew:welcome-dismissed';

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
export function WelcomeCard({ orgSlug }: { orgSlug: string }) {
  const [state, setState] = useState<'visible' | 'dismissed'>('visible');

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
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-200">
            <li>
              <Link className="underline hover:text-sky-700 dark:hover:text-sky-300" href={`/orgs/${orgSlug}/projects/acme`}>
                Open the seeded demo project
              </Link>{' '}
              to see a completed multi-agent run, its three agent steps, and the resulting changeset.
            </li>
            <li>
              <Link className="underline hover:text-sky-700 dark:hover:text-sky-300" href={`/orgs/${orgSlug}/projects`}>
                Projects
              </Link>{' '}
              is where you wire your own repo + deploy target.
            </li>
            <li>
              The{' '}
              <Link className="underline hover:text-sky-700 dark:hover:text-sky-300" href={`/orgs/${orgSlug}/projects/acme/lifecycle`}>
                Lifecycle
              </Link>{' '}
              page edits the YAML that defines agents + workflows for a project.
            </li>
          </ul>
          <div className="text-sm">
            <a
              className="font-medium text-sky-700 underline hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100"
              href="https://github.com/mergecrew/mergecrew/blob/main/docs/00-quickstart.md"
              target="_blank"
              rel="noreferrer"
            >
              5-minute quickstart →
            </a>
          </div>
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
