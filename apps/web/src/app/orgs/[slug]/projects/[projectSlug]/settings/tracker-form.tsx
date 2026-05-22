'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { upsertTrackerAction, deleteTrackerAction, testTrackerAction } from './tracker-actions';

interface TrackerState {
  id: string;
  adapterId: string;
  config: Record<string, unknown>;
  hasToken: boolean;
}

export function TrackerForm({
  slug,
  projectSlug,
  initial,
}: {
  slug: string;
  projectSlug: string;
  initial: TrackerState | null;
}) {
  const [adapterId, setAdapterId] = useState(initial?.adapterId ?? 'github-issues');
  const [repoFullName, setRepoFullName] = useState(String(initial?.config?.repoFullName ?? ''));
  const [teamId, setTeamId] = useState(String(initial?.config?.teamId ?? ''));
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState<
    null | { ok: true; sample?: unknown } | { ok: false; error: string }
  >(null);
  const [pending, startTransition] = useTransition();

  const isGithub = adapterId === 'github-issues';

  const onSave = () => {
    setTestResult(null);
    startTransition(async () => {
      const config: Record<string, unknown> = isGithub
        ? { repoFullName }
        : { ...(teamId ? { teamId } : {}) };
      await upsertTrackerAction(slug, projectSlug, {
        adapterId,
        config,
        token: token || undefined,
      });
      setToken('');
    });
  };

  const onDelete = () => {
    setTestResult(null);
    startTransition(async () => {
      await deleteTrackerAction(slug, projectSlug);
    });
  };

  const onTest = () => {
    startTransition(async () => {
      const r = await testTrackerAction(slug, projectSlug);
      setTestResult(r as any);
    });
  };

  return (
    <div className="space-y-3">
      {initial && (
        <div className="rounded bg-bg p-2 text-xs ">
          <div>
            <span className="text-muted">Currently configured:</span>{' '}
            <span className="font-mono">{initial.adapterId}</span>
            {initial.config?.repoFullName ? (
              <>
                {' '}
                · <span className="font-mono">{String(initial.config.repoFullName)}</span>
              </>
            ) : null}
          </div>
          <div className="text-muted">
            Token:{' '}
            <span
              className={
                initial.hasToken
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-rose-700 dark:text-rose-300'
              }
            >
              {initial.hasToken ? 'stored' : 'missing'}
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-ink-2">Adapter</span>
          <select
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] "
            value={adapterId}
            onChange={(e) => setAdapterId(e.target.value)}
          >
            <option value="github-issues">GitHub Issues</option>
            <option value="linear">Linear</option>
          </select>
        </label>

        {isGithub ? (
          <label className="text-sm">
            <span className="block text-ink-2">Repository (owner/repo)</span>
            <input
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
              placeholder="acme/webapp"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
            />
          </label>
        ) : (
          <label className="text-sm">
            <span className="block text-ink-2">Linear team ID (optional)</span>
            <input
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
              placeholder="TEAM_UUID"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            />
          </label>
        )}
      </div>

      <label className="block text-sm">
        <span className="block text-ink-2">
          {isGithub
            ? 'GitHub token (PAT with repo / public_repo scope, or installation token)'
            : 'Linear API key'}
          {initial?.hasToken && (
            <span className="ml-2 text-xs text-muted-2">— leave blank to keep existing</span>
          )}
        </span>
        <input
          type="password"
          className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
          placeholder={initial?.hasToken ? '••••••••' : 'paste token here'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {isGithub && (
          <span className="mt-1 block text-xs text-muted">
            Create one at{' '}
            <a
              className="underline"
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noreferrer"
            >
              github.com/settings/tokens
            </a>{' '}
            with read access to issues.
          </span>
        )}
      </label>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onSave} disabled={pending} variant="primary">
          {initial ? 'Save changes' : 'Configure tracker'}
        </Button>
        {initial && (
          <Button onClick={onTest} disabled={pending} variant="secondary">
            Test connection
          </Button>
        )}
        {initial && (
          <Button onClick={onDelete} disabled={pending} variant="secondary">
            Remove
          </Button>
        )}
      </div>

      {testResult && (
        <div
          className={`rounded p-2 text-xs ${
            testResult.ok
              ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-900/20 dark:text-rose-300'
          }`}
        >
          {testResult.ok ? (
            <>
              <div className="font-semibold">Connection OK.</div>
              {Array.isArray((testResult as any).sample) &&
              (testResult as any).sample.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {(
                    (testResult as any).sample as Array<{
                      id: string;
                      title: string;
                      status?: string;
                    }>
                  ).map((it) => (
                    <li key={it.id} className="font-mono">
                      #{it.id} · {it.title}
                      {it.status ? ` (${it.status})` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 italic">No issues returned (repo may be empty).</div>
              )}
            </>
          ) : (
            <>
              <div className="font-semibold">Connection failed.</div>
              <div className="mt-1 font-mono">{(testResult as any).error}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
