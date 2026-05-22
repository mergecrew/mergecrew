'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { upsertErrorTargetAction, deleteErrorTargetAction } from './error-target-actions';

interface ErrorTargetState {
  id: string;
  adapterId: string;
  config: Record<string, unknown>;
  hasToken: boolean;
}

export function ErrorTargetForm({
  slug,
  projectSlug,
  initial,
}: {
  slug: string;
  projectSlug: string;
  initial: ErrorTargetState | null;
}) {
  const [adapterId, setAdapterId] = useState(initial?.adapterId ?? 'sentry');
  const [org, setOrg] = useState(String(initial?.config?.org ?? ''));
  const [project, setProject] = useState(String(initial?.config?.project ?? ''));
  const [token, setToken] = useState('');
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    startTransition(async () => {
      const config: Record<string, unknown> = { org, project };
      await upsertErrorTargetAction(slug, projectSlug, {
        adapterId,
        config,
        token: token || undefined,
      });
      setToken('');
    });
  };

  const onDelete = () => {
    startTransition(async () => {
      await deleteErrorTargetAction(slug, projectSlug);
    });
  };

  return (
    <div className="space-y-3">
      {initial && (
        <div className="rounded bg-bg p-2 text-xs ">
          <div>
            <span className="text-muted">Currently configured:</span>{' '}
            <span className="font-mono">{initial.adapterId}</span>
            {initial.config?.org && initial.config?.project ? (
              <>
                {' '}
                ·{' '}
                <span className="font-mono">
                  {String(initial.config.org)}/{String(initial.config.project)}
                </span>
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

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="block text-ink-2">Adapter</span>
          <select
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] "
            value={adapterId}
            onChange={(e) => setAdapterId(e.target.value)}
          >
            <option value="sentry">Sentry</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-ink-2">Sentry org slug</span>
          <input
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
            placeholder="acme"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
        </label>

        <label className="text-sm">
          <span className="block text-ink-2">Sentry project slug</span>
          <input
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
            placeholder="webapp"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="block text-ink-2">
          Sentry auth token
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
        <span className="mt-1 block text-xs text-muted">
          Create at{' '}
          <a
            className="underline"
            href="https://sentry.io/settings/account/api/auth-tokens/"
            target="_blank"
            rel="noreferrer"
          >
            sentry.io/settings/account/api/auth-tokens
          </a>{' '}
          with <code>project:read</code> + <code>event:read</code> scopes.
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onSave} disabled={pending} variant="primary">
          {initial ? 'Save changes' : 'Configure error tracker'}
        </Button>
        {initial && (
          <Button onClick={onDelete} disabled={pending} variant="secondary">
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
