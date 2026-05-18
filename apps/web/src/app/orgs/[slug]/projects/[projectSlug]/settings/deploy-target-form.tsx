'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  ADAPTERS,
  DeployTargetFormFor,
  defaultConfigFor,
  type AdapterId,
} from '@/components/deploy-target-forms';
import {
  upsertDeployTargetAction,
  deleteDeployTargetAction,
} from './settings-actions';

type Kind = 'dev' | 'staging' | 'prod';

export interface DeployTargetRow {
  id: string;
  kind: Kind;
  adapterId: string;
  config: Record<string, unknown>;
}

// (#500 phase 1) Default to dev + prod — most teams don't run a
// staging environment, and the empty staging row was visual noise.
// Existing projects that already have a saved staging target keep it
// visible via the `union with initial[].kind` below.
const DEFAULT_KINDS: Kind[] = ['dev', 'prod'];

/**
 * V2.z deploy-target editor (#266).
 *
 * One row per kind. The adapter picker swaps in the matching typed form
 * from `@/components/deploy-target-forms/` so an operator never has to
 * paste raw jsonb to wire a new target. The API surface is unchanged —
 * each adapter form returns the same Record<string, unknown> the upsert
 * endpoint already accepts.
 *
 * `kinds` defaults to all three kinds; the inline onboarding wizard
 * passes `kinds={['dev']}` to render only the dev row, since that's the
 * only target the wizard step covers (#455).
 *
 * `installFrom='wizard'` (#467) collapses the row to just the URL field
 * for the `external-ci` adapter — the wizard assumes the user already
 * has their own CI/CD wired up and just needs mergecrew to know where
 * the preview is published. Setting page keeps the full picker.
 */
export function DeployTargetForm({
  slug,
  projectSlug,
  initial,
  kinds = DEFAULT_KINDS,
  installFrom = 'settings',
  baseBranch,
}: {
  slug: string;
  projectSlug: string;
  initial: DeployTargetRow[];
  kinds?: Kind[];
  installFrom?: 'wizard' | 'settings';
  /**
   * The base branch from the connected repo (#467). In wizard mode we
   * render it as a read-only confirmation so the user sees which branch
   * their CI/CD will be deploying after merge.
   */
  baseBranch?: string;
}) {
  // Union the requested kinds with any extra kinds already saved on
  // the project (#500). This keeps an existing staging row visible
  // after the default flipped from dev/staging/prod → dev/prod — the
  // operator who wired staging earlier doesn't suddenly lose access
  // to it. Preserves stable display order: dev → staging → prod →
  // anything else.
  const ORDER: Kind[] = ['dev', 'staging', 'prod'];
  const renderedKinds = Array.from(new Set<Kind>([...kinds, ...initial.map((t) => t.kind)])).sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  );
  return (
    <div className="space-y-4">
      {renderedKinds.map((kind) => (
        <KindRow
          key={kind}
          slug={slug}
          projectSlug={projectSlug}
          kind={kind}
          existing={initial.find((t) => t.kind === kind)}
          installFrom={installFrom}
          baseBranch={baseBranch}
        />
      ))}
    </div>
  );
}

function KindRow({
  slug,
  projectSlug,
  kind,
  existing,
  installFrom,
  baseBranch,
}: {
  slug: string;
  projectSlug: string;
  kind: Kind;
  existing?: DeployTargetRow;
  installFrom: 'wizard' | 'settings';
  baseBranch?: string;
}) {
  const isWizard = installFrom === 'wizard';
  const defaultAdapter: AdapterId = isWizard ? 'external-ci' : 'github-actions';
  const [editing, setEditing] = useState(!existing);
  const [adapterId, setAdapterId] = useState<AdapterId>(
    isKnownAdapter(existing?.adapterId) ? (existing!.adapterId as AdapterId) : defaultAdapter,
  );
  const [config, setConfig] = useState<Record<string, unknown>>(
    existing?.config ?? defaultConfigFor(adapterId),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSave = () => {
    setError(null);
    startTransition(async () => {
      try {
        await upsertDeployTargetAction(slug, projectSlug, { kind, adapterId, config });
        setEditing(false);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  const onDelete = () => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteDeployTargetAction(slug, projectSlug, kind);
        setConfig(defaultConfigFor(adapterId));
        setEditing(true);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  return (
    <div className="rounded border p-3 dark:border-zinc-800">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="font-mono text-sm font-semibold uppercase">{kind}</span>
          {existing && !editing && (
            <span className="ml-3 text-xs text-zinc-500">{existing.adapterId}</span>
          )}
        </div>
        <div className="flex gap-2">
          {existing && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
              Edit
            </Button>
          )}
          {existing && (
            <Button variant="secondary" onClick={onDelete} disabled={pending}>
              Remove
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3">
          {isWizard && baseBranch && (
            <div className="rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
              <span className="text-zinc-500">Mergecrew opens PRs against</span>{' '}
              <span className="font-mono">{baseBranch}</span>
              <span className="text-zinc-500">. After merge, your CI/CD deploys to the URL below.</span>
            </div>
          )}

          {!isWizard && (
            <label className="block text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">Adapter</span>
              <select
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
                value={adapterId}
                onChange={(e) => {
                  const next = e.target.value as AdapterId;
                  setAdapterId(next);
                  setConfig(defaultConfigFor(next));
                }}
              >
                {ADAPTERS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <DeployTargetFormFor adapterId={adapterId} config={config} onChange={setConfig} />

          {isWizard && (
            <p className="text-xs text-zinc-500">
              Already running a custom deploy pipeline (Vercel, Netlify, Render, Fly, AWS,
              direct GitHub Actions)? You can switch adapter later in{' '}
              <a
                className="underline"
                href={`/orgs/${slug}/projects/${projectSlug}/settings`}
              >
                project settings
              </a>
              . See the{' '}
              <a
                className="underline"
                href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/06-deploy-targets-cookbook.md"
                target="_blank"
                rel="noreferrer"
              >
                deploy-targets cookbook
              </a>{' '}
              for which adapter fits each setup.
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={onSave} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            {existing && (
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const KNOWN_ADAPTERS = new Set<string>(ADAPTERS.map((a) => a.id));
function isKnownAdapter(id: string | undefined): id is AdapterId {
  return typeof id === 'string' && KNOWN_ADAPTERS.has(id);
}
