'use client';

import { useEffect, useRef } from 'react';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';

const STORAGE_KEY = 'mergecrew:demo-tour-completed';
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
 *   - Auto-starts when `localStorage[STORAGE_KEY]` is unset.
 *   - "Replay tour" button (rendered elsewhere) flips the same key off
 *     by appending `?tour=replay` to the URL — this component picks
 *     that up and re-runs the tour regardless of prior completion.
 *   - Skip + Done both write the key so a refresh doesn't re-trigger.
 */
export function DemoProjectTour({ orgSlug }: { orgSlug: string }) {
  const driverRef = useRef<Driver | null>(null);

  useEffect(() => {
    const shouldReplay =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get(TOUR_REPLAY_PARAM) === 'replay';
    let alreadyDone = false;
    try {
      alreadyDone = Boolean(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // Restricted localStorage — treat as not-yet-done so the tour
      // runs at least once per session.
    }
    if (alreadyDone && !shouldReplay) return;

    const markDone = () => {
      try {
        window.localStorage.setItem(STORAGE_KEY, '1');
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
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    d.drive();

    return () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    };
  }, [orgSlug]);

  return null;
}
