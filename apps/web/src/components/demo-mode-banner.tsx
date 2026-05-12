'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'mergecrew:demo-banner-dismissed';

/**
 * Top-of-page banner that flags an instance running in demo mode
 * (#374, V2.ag). When `MERGECREW_DEMO_MODE=1` is set on the server,
 * the agent loop bypasses the LLM and returns canned per-kind output
 * — useful for adoption (no credentials needed to see a real run)
 * but dangerous if an operator forgets and assumes their agents are
 * doing real work. The banner makes the mode unambiguous.
 *
 * Server-rendered eagerly so first-paint shows it (matches the
 * welcome card fix from #365). Dismissal lives in localStorage under
 * its own key, separate from the welcome card — operators may want
 * to dismiss the welcome card but keep this one visible as a
 * reminder.
 */
export function DemoModeBanner() {
  const [state, setState] = useState<'visible' | 'dismissed'>('visible');

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) {
        setState('dismissed');
      }
    } catch {
      // Restricted-context localStorage: leave the banner visible.
      // Less-broken than a banner that never appears for the operator
      // who set MERGECREW_DEMO_MODE=1 on purpose.
    }
  }, []);

  if (state !== 'visible') return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setState('dismissed');
  };

  return (
    <div className="border-b border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-2 text-sm">
        <span>
          <strong>Demo mode</strong> — agent steps run against a deterministic stub. No LLM is contacted. Set{' '}
          <code className="rounded bg-amber-200/60 px-1 dark:bg-amber-900/60">MERGECREW_DEMO_MODE=0</code> + connect an LLM provider in Settings to enable real runs.
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-200/70 dark:border-amber-700 dark:hover:bg-amber-900/60"
          aria-label="Dismiss demo mode banner"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
