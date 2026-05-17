'use client';

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';

const STORAGE_KEY_PREFIX = 'mergecrew:demo-tour-completed';
export const TOUR_REPLAY_PARAM = 'tour';

/**
 * Coachmark tour for the demo project FTE (#442). Walks first-time
 * operators through the seeded project's anchors — what a Run is, the
 * agent chain, the changeset, and how to escape into the wizard.
 *
 * Built on `driver.js` (MIT, vanilla, React-19 compatible — picked over
 * `react-joyride` after its react peer dep was capped at <=18). The
 * library is imperative, so this wrapper is a client component that
 * spins up a `Driver` instance on mount + tears it down on unmount.
 *
 * State:
 *   - Storage key is scoped per-org so a fresh org always gets a
 *     fresh tour. Without the scope, a user who skipped the tour on
 *     one org would never see it on subsequent orgs even if they
 *     reset the backend.
 *   - Auto-starts when the per-org key is unset.
 *   - "Replay tour" button (rendered elsewhere) appends `?tour=replay`
 *     to the URL — the effect re-fires on search-param change via
 *     `useSearchParams()` and re-runs the tour regardless of prior
 *     completion. (Next.js client-side nav doesn't unmount this
 *     component, so a search-param dep is required.)
 *   - Skip + Done both write the key so a refresh doesn't re-trigger.
 */
export function DemoProjectTour({ orgSlug }: { orgSlug: string }) {
  const driverRef = useRef<Driver | null>(null);
  const searchParams = useSearchParams();
  const tourParam = searchParams?.get(TOUR_REPLAY_PARAM) ?? null;

  useEffect(() => {
    const storageKey = `${STORAGE_KEY_PREFIX}:${orgSlug}`;
    const shouldReplay = tourParam === 'replay';
    let alreadyDone = false;
    try {
      alreadyDone = Boolean(window.localStorage.getItem(storageKey));
    } catch {
      // Restricted localStorage — treat as not-yet-done so the tour
      // runs at least once per session.
    }
    if (alreadyDone && !shouldReplay) return;

    const markDone = () => {
      try {
        window.localStorage.setItem(storageKey, '1');
      } catch {
        // ignore
      }
    };

    const d = driver({
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.55,
      onCloseClick: () => {
        markDone();
        d.destroy();
      },
      onDestroyed: markDone,
      steps: [
        {
          element: '[data-tour="project-header"]',
          popover: {
            title: 'This is the demo project',
            description:
              'A read-only example seeded for your org. Your real projects will live alongside it once you finish setup.',
          },
        },
        {
          element: '[data-tour="latest-run"]',
          popover: {
            title: 'Each day, agents run on a schedule',
            description:
              'mergecrew dispatches a planner → coder → reviewer chain against your repo. The most recent run is summarized here — click in to see the full timeline.',
          },
        },
        {
          element: '[data-tour="approvals"]',
          popover: {
            title: 'You decide what gets promoted',
            description:
              'Production promotion always requires a human decision. Anything that needs your sign-off queues here.',
          },
        },
        {
          element: '[data-tour="changesets"]',
          popover: {
            title: 'The output is a PR proposal',
            description:
              'Each run produces a Changeset — real code, opened as a draft PR on your repo. Not just suggestions.',
          },
        },
        {
          element: '[data-tour="manage-lifecycle"]',
          popover: {
            title: 'Agents are configurable',
            description:
              'The Lifecycle page edits the YAML that defines agents, workflows, custom skills, and human gates per project.',
          },
        },
        {
          element: '[data-tour="setup-cta"]',
          popover: {
            title: 'Ready to wire your own repo?',
            description:
              'Set up your own project from the wizard — connect an LLM provider, a repo, and a dev deploy target. Five steps from here to your first real run.',
          },
          onHighlightStarted: () => {
            // Final step — scroll the CTA into view in case the user
            // is on a small viewport and the tour has been jumping
            // around the page.
            const el = document.querySelector('[data-tour="setup-cta"]');
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
        },
      ],
    });

    driverRef.current = d;

    // Strip the ?tour=replay query string after kicking off so a
    // refresh doesn't re-replay automatically.
    if (shouldReplay && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete(TOUR_REPLAY_PARAM);
      window.history.replaceState({}, '', url.toString());
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }

    d.drive();

    return () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    };
  }, [orgSlug, tourParam]);

  return null;
}
