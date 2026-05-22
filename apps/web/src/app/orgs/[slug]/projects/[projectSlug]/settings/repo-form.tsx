'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { connectRepoAction, disconnectRepoAction } from './settings-actions';

interface ConnectedRepo {
  repoFullName: string;
  defaultBranch: string;
  installationId: string;
  repoId: string;
  /**
   * Branch mergecrew opens new PRs against (#469). NULL means
   * "coalesce to defaultBranch" — trunk-based teams leave it blank.
   */
  basePrBranch: string | null;
}

interface AvailableRepo {
  repoId: string;
  repoFullName: string;
  defaultBranch: string;
  private: boolean;
}

export function RepoForm({
  slug,
  projectSlug,
  initial,
  installedInstallationId,
  availableRepos = [],
  installFrom = 'settings',
}: {
  slug: string;
  projectSlug: string;
  initial: ConnectedRepo | null;
  /**
   * V1.1 (#7): when the user just completed a GitHub App install, the
   * callback redirects them back to this page with an `installation_id`
   * query param. We pre-fill the form so they only need to pick the repo
   * name — the install id has already been determined by GitHub.
   */
  installedInstallationId?: string | null;
  /**
   * #184: repos the just-completed GitHub App installation was granted
   * access to. When non-empty, the form replaces the free-text inputs
   * with a dropdown so the user doesn't have to retype names.
   */
  availableRepos?: AvailableRepo[];
  /**
   * #455: which surface kicked off the GitHub App install round-trip.
   * The API callback uses this to decide where to land the user after
   * GitHub redirects back — `wizard` keeps them on
   * `/orgs/{slug}/onboarding`, `settings` (default) keeps the legacy
   * settings-page behavior.
   */
  installFrom?: 'wizard' | 'settings';
}) {
  const [repoFullName, setRepoFullName] = useState(initial?.repoFullName ?? '');
  const [defaultBranch, setDefaultBranch] = useState(initial?.defaultBranch ?? 'main');
  const [basePrBranch, setBasePrBranch] = useState(initial?.basePrBranch ?? '');
  const [installationId, setInstallationId] = useState(
    installedInstallationId ?? initial?.installationId ?? '',
  );
  const [repoId, setRepoId] = useState(initial?.repoId ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hasDropdown = availableRepos.length > 0;
  const onPickRepo = (full: string) => {
    const r = availableRepos.find((x) => x.repoFullName === full);
    if (!r) return;
    setRepoFullName(r.repoFullName);
    setDefaultBranch(r.defaultBranch);
    setRepoId(r.repoId);
    // basePrBranch stays as the user typed it; if blank, server coalesces
    // to defaultBranch — same behavior as before #469 for trunk-based teams.
  };

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
          // Empty string here collapses server-side to null and coalesces
          // back to defaultBranch on read — trunk-based teams stay untouched.
          basePrBranch: basePrBranch.trim() || null,
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

  // BFF route (#457). The raw API endpoint requires a Bearer JWT
  // that the browser doesn't carry on cross-subdomain navigation;
  // routing through the web tier lets us forward auth properly and
  // keeps the install URL same-origin.
  const installHref = `/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectSlug)}/install-github?from=${installFrom}`;

  return (
    <div className="space-y-3">
      {initial && (
        <div className="rounded bg-bg p-2 text-xs ">
          <span className="text-muted">Currently connected:</span>{' '}
          <span className="font-mono">{initial.repoFullName}</span>
          <span className="text-muted"> · branch </span>
          <span className="font-mono">{initial.defaultBranch}</span>
        </div>
      )}

      {installedInstallationId && hasDropdown && (
        <div className="rounded bg-emerald-50 p-2 text-xs text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200">
          GitHub App installed. Pick the repository this project should connect to from the list
          below — only repos the App was granted access to during install are shown.
        </div>
      )}
      {!installedInstallationId && hasDropdown && (
        <div className="rounded bg-bg p-2 text-xs text-zinc-700 dark:text-muted-2">
          Picking a different repo from this installation will rewire the project. Repos shown are
          the ones the saved installation has access to.
        </div>
      )}
      {installedInstallationId && !hasDropdown && (
        <div className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          GitHub App installed, but the server couldn&apos;t list its accessible repos (likely
          because <code>GITHUB_APP_ID</code> / <code>GITHUB_APP_PRIVATE_KEY</code> aren&apos;t
          configured). Type the repository name manually and click Connect.
        </div>
      )}

      {!initial && !installedInstallationId && (
        <div className="rounded border border-dashed p-3 text-sm ">
          <p className="text-ink-2">
            No repository connected. The fastest path is to install the Mergecrew GitHub App on the
            repo you want this project to work against — we&apos;ll bring you back here with the
            installation id pre-filled.
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
          <span className="block text-ink-2">Repository (owner/repo)</span>
          {hasDropdown ? (
            <select
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
              value={repoFullName}
              onChange={(e) => onPickRepo(e.target.value)}
            >
              <option value="">— select a repo —</option>
              {availableRepos.map((r) => (
                <option key={r.repoId} value={r.repoFullName}>
                  {r.repoFullName}
                  {r.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
              placeholder="acme/webapp"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
            />
          )}
        </label>
        <label className="text-sm">
          <span className="block text-ink-2">Default branch</span>
          <input
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
            placeholder="main"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
          />
          <span className="block text-xs text-muted">
            What GitHub reports as the repo&apos;s default branch.
          </span>
        </label>
        <label className="text-sm">
          <span className="block text-ink-2">
            Branch mergecrew opens PRs against{' '}
            <span className="text-xs text-muted-2">(defaults to default branch)</span>
          </span>
          <input
            className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
            placeholder={defaultBranch || 'main'}
            value={basePrBranch}
            onChange={(e) => setBasePrBranch(e.target.value)}
          />
          <span className="block text-xs text-muted">
            For branch-per-env workflows (e.g. <code>developer</code> → dev, <code>qa</code> →
            stage, <code>main</code> → prod), point this at your integration branch. Leave blank for
            trunk-based projects.
          </span>
        </label>
        {installFrom !== 'wizard' && (
          <>
            <label className="text-sm">
              <span className="block text-ink-2">
                GitHub App installation ID{' '}
                <span className="text-xs text-muted-2">(optional in dev)</span>
              </span>
              <input
                className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
                placeholder="manual"
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="block text-ink-2">
                Repo numeric ID <span className="text-xs text-muted-2">(optional in dev)</span>
              </span>
              <input
                className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
                placeholder="leave blank"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
              />
            </label>
          </>
        )}
      </div>

      {installFrom !== 'wizard' && (
        <p className="text-xs text-muted">
          For real GitHub App-based access, set <code>GITHUB_APP_ID</code> and{' '}
          <code>GITHUB_APP_PRIVATE_KEY</code> in your environment and provide the installation ID.
          Without those, the connection is informational and the runner won't be able to push
          commits — but skills like <code>repo.read_file</code> can still operate on a workspace
          clone.
        </p>
      )}

      <div className="rounded border border-emerald-200 bg-emerald-50/50 p-2 text-xs text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200">
        <span className="font-medium">Issues source: GitHub Issues.</span> We&apos;ll wire{' '}
        <code>tracker.list_issues</code> / <code>tracker.create_issue</code> to this repo&apos;s
        Issues tab on connect — Discovery and BugTriage agents call those every run. Switch to
        Linear later from the project&apos;s Integrations page.
      </div>

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
        <div className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </div>
      )}
    </div>
  );
}
