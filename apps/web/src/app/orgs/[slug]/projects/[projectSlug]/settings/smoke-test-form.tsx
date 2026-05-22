'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { runSmokeTestAction } from './settings-actions';

interface SmokeTestResult {
  prUrl: string;
  prNumber: number;
  branch: string;
  deployStatus: 'success' | 'failed' | 'cancelled' | 'timeout';
  devUrl: string | null;
  workflowRunId: string;
  durationMs: number;
}

/**
 * V1.1 onboarding smoke (#7).
 *
 * Triggers the round-trip end-to-end check: opens a no-op draft PR,
 * dispatches the dev workflow, awaits completion, returns the dev URL.
 * "Does any of this actually work" in one click — the J1 step 5 from
 * the user-journeys doc.
 */
export function SmokeTestForm({
  slug,
  projectSlug,
  ready,
  blockedReason,
}: {
  slug: string;
  projectSlug: string;
  ready: boolean;
  blockedReason?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SmokeTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRun = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await runSmokeTestAction(slug, projectSlug);
        setResult(r as SmokeTestResult);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  if (!ready) {
    return (
      <p className="text-sm text-muted">
        {blockedReason ??
          'Connect a repo and set a dev deploy target before running the smoke test.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Button onClick={onRun} disabled={pending} variant="primary">
          {pending ? 'Running…' : result ? 'Re-run' : 'Run smoke test'}
        </Button>
        <p className="mt-2 text-xs text-muted">
          Opens a draft PR with a marker file, dispatches dev deploy, waits for completion (5-min
          timeout). Non-destructive — the PR is left open for you to close.
        </p>
      </div>

      {pending && (
        <p className="text-xs text-muted">
          This can take a few minutes. The page will update when the deploy finishes.
        </p>
      )}

      {error && (
        <div className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </div>
      )}

      {result && <Outcome result={result} />}
    </div>
  );
}

function Outcome({ result }: { result: SmokeTestResult }) {
  const ok = result.deployStatus === 'success';
  return (
    <div
      className={
        'rounded p-3 text-sm ' +
        (ok
          ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200'
          : 'bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200')
      }
    >
      <div className="font-semibold">
        {ok ? 'Round-trip OK' : `Deploy ${result.deployStatus}`} ·{' '}
        {(result.durationMs / 1000).toFixed(1)}s
      </div>
      <ul className="mt-1 space-y-1 text-xs">
        <li>
          PR:{' '}
          <a className="underline" href={result.prUrl} target="_blank" rel="noreferrer">
            #{result.prNumber} ({result.branch})
          </a>
        </li>
        <li>
          Workflow run id: <code>{result.workflowRunId}</code>
        </li>
        <li>
          Dev URL:{' '}
          {result.devUrl ? (
            <a className="underline" href={result.devUrl} target="_blank" rel="noreferrer">
              {result.devUrl}
            </a>
          ) : (
            <span className="text-muted">
              (none resolved — check the deploy target's URL configuration)
            </span>
          )}
        </li>
      </ul>
    </div>
  );
}
