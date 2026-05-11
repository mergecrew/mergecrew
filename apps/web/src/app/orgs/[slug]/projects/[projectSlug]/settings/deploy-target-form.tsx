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

const KINDS: Kind[] = ['dev', 'staging', 'prod'];

/**
 * V2.z deploy-target editor (#266).
 *
 * One row per kind (dev / staging / prod). The adapter picker swaps in
 * the matching typed form from `@/components/deploy-target-forms/` so
 * an operator never has to paste raw jsonb to wire a new target.
 * The API surface is unchanged — each adapter form returns the same
 * Record<string, unknown> the upsert endpoint already accepts.
 */
export function DeployTargetForm({
  slug,
  projectSlug,
  initial,
}: {
  slug: string;
  projectSlug: string;
  initial: DeployTargetRow[];
}) {
  return (
    <div className="space-y-4">
      {KINDS.map((kind) => (
        <KindRow
          key={kind}
          slug={slug}
          projectSlug={projectSlug}
          kind={kind}
          existing={initial.find((t) => t.kind === kind)}
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
}: {
  slug: string;
  projectSlug: string;
  kind: Kind;
  existing?: DeployTargetRow;
}) {
  const [editing, setEditing] = useState(!existing);
  const [adapterId, setAdapterId] = useState<AdapterId>(
    isKnownAdapter(existing?.adapterId) ? (existing!.adapterId as AdapterId) : 'github-actions',
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

          <DeployTargetFormFor adapterId={adapterId} config={config} onChange={setConfig} />

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
