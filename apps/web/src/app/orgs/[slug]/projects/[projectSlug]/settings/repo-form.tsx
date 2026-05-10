'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { connectRepoAction, disconnectRepoAction } from './settings-actions';

interface ConnectedRepo {
  repoFullName: string;
  defaultBranch: string;
  installationId: string;
  repoId: string;
}

export function RepoForm({
  slug,
  projectSlug,
  initial,
  installedInstallationId,
}: {
  slug: string;
  projectSlug: string;
  initial: ConnectedRepo | null;
  /**
   * V1.1 (#7): when the user just completed a GitHub App install, the
   * callback redirects them back to this page with an `installation_id`
   * query param. We pre-fill the form so they only need to type the repo
   * name — the install id has already been determined by GitHub.
   */
  installedInstallationId?: string | null;
}) {
  const [repoFullName, setRepoFullName] = useState(initial?.repoFullName ?? '');
  const [defaultBranch, setDefaultBranch] = useState(initial?.defaultBranch ?? 'main');
  const [installationId, setInstallationId] = useState(
    installedInstallationId ?? initial?.installationId ?? '',
  );
  const [repoId, setRepoId] = useState(initial?.repoId ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSave = () => {
    setError(null);
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName.trim())) {
      setError('Repository must be in the form "owner/repo".');
      return;
    }
    startTransition(async () => {
      try {
        await connectRepoAction(slug, projectSlug, {
          repoFullName: repoFullName.trim(),
          defaultBranch: defaultBranch.trim() || 'main',
          installationId: installationId.trim() || 'manual',
          repoId: repoId.trim() || repoFullName.trim(),
        });
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  const onDisconnect = () => {
    setError(null);
    startTransition(async () => {
      try {
        await disconnectRepoAction(slug, projectSlug);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  const installHref = `${apiBase}/v1/integrations/github/install?org=${encodeURIComponent(slug)}&project=${encodeURIComponent(projectSlug)}`;

  return (
    <div className="space-y-3">
      {initial && (
        <div className="rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
          <span className="text-zinc-500">Currently connected:</span>{' '}
          <span className="font-mono">{initial.repoFullName}</span>
          <span className="text-zinc-500"> · branch </span>
          <span className="font-mono">{initial.defaultBranch}</span>
        </div>
      )}

      {installedInstallationId && (
        <div className="rounded bg-emerald-50 p-2 text-xs text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
          GitHub App installed. Type the repository this project should connect
          to (must be one the App was given access to during install) and click
          Connect.
        </div>
      )}

      {!initial && !installedInstallationId && (
        <div className="rounded border border-dashed p-3 text-sm dark:border-zinc-800">
          <p className="text-zinc-600 dark:text-zinc-400">
            No repository connected. The fastest path is to install the
            Mergecrew GitHub App on the repo you want this project to work
            against — we&apos;ll bring you back here with the installation id
            pre-filled.
          </p>
          <div className="mt-2">
            <a href={installHref}>
              <Button variant="primary">Install GitHub App</Button>
            </a>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            Repository (owner/repo)
          </span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="acme/webapp"
            value={repoFullName}
            onChange={(e) => setRepoFullName(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Default branch</span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="main"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            GitHub App installation ID{' '}
            <span className="text-xs text-zinc-400">(optional in dev)</span>
          </span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="manual"
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            Repo numeric ID{' '}
            <span className="text-xs text-zinc-400">(optional in dev)</span>
          </span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="leave blank"
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
          />
        </label>
      </div>

      <p className="text-xs text-zinc-500">
        For real GitHub App-based access, set <code>GITHUB_APP_ID</code> and{' '}
        <code>GITHUB_APP_PRIVATE_KEY</code> in your environment and provide the installation ID.
        Without those, the connection is informational and the runner won't be able to push commits
        — but skills like <code>repo.read_file</code> can still operate on a workspace clone.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onSave} disabled={pending} variant="primary">
          {initial ? 'Update connection' : 'Connect repository'}
        </Button>
        {initial && (
          <Button onClick={onDisconnect} disabled={pending} variant="secondary">
            Disconnect
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
