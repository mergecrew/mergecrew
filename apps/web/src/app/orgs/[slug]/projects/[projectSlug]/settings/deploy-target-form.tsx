'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  upsertDeployTargetAction,
  deleteDeployTargetAction,
} from './settings-actions';

type Kind = 'dev' | 'staging' | 'prod';
type AdapterId = 'github-actions' | 'vercel' | 'netlify' | 'render';

export interface DeployTargetRow {
  id: string;
  kind: Kind;
  adapterId: string;
  config: Record<string, unknown>;
}

const KINDS: Kind[] = ['dev', 'staging', 'prod'];
const ADAPTERS: Array<{ id: AdapterId; label: string }> = [
  { id: 'github-actions', label: 'GitHub Actions' },
  { id: 'vercel', label: 'Vercel' },
  { id: 'netlify', label: 'Netlify' },
  { id: 'render', label: 'Render' },
];

/**
 * V1.1 deploy-target editor (#7).
 *
 * Renders one row per kind (dev / staging / prod) with adapter + config
 * fields visible inline. The shape of `config` differs by adapter — only
 * github-actions is wired up with a structured form (the V0.5 path); the
 * others fall back to a free-text JSON editor for now. Mergecrew Inception
 * pre-fills the workflow filename and the deploy URL pattern when the user
 * has just analyzed their repo.
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
    (existing?.adapterId as AdapterId) ?? 'github-actions',
  );
  const [config, setConfig] = useState<Record<string, unknown>>(
    existing?.config ?? defaultConfig(adapterId),
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
        setConfig(defaultConfig(adapterId));
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
                setConfig(defaultConfig(next));
              }}
            >
              {ADAPTERS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          {adapterId === 'github-actions' ? (
            <GitHubActionsConfig config={config} onChange={setConfig} />
          ) : (
            <JsonConfig config={config} onChange={setConfig} adapterId={adapterId} />
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

interface GhConfig {
  installationId?: string;
  repoFullName?: string;
  workflowFilename?: string;
  inputsTemplate?: Record<string, string>;
  urlResolution?: 'pattern' | 'fixed' | 'workflow_output';
  urlPattern?: string;
  urlFixed?: string;
}

function GitHubActionsConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const c = config as GhConfig;
  const update = (patch: Partial<GhConfig>) => onChange({ ...c, ...patch });

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Installation ID"
        value={c.installationId ?? ''}
        onChange={(v) => update({ installationId: v })}
        hint="GitHub App installation that owns the repo's Actions API."
      />
      <Field
        label="Repository (owner/repo)"
        value={c.repoFullName ?? ''}
        onChange={(v) => update({ repoFullName: v })}
        placeholder="acme/webapp"
      />
      <Field
        label="Workflow filename"
        value={c.workflowFilename ?? ''}
        onChange={(v) => update({ workflowFilename: v })}
        placeholder="deploy-dev.yml"
        hint="A file in .github/workflows/ accepting workflow_dispatch."
      />
      <label className="text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">URL resolution</span>
        <select
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          value={c.urlResolution ?? 'pattern'}
          onChange={(e) => update({ urlResolution: e.target.value as GhConfig['urlResolution'] })}
        >
          <option value="pattern">pattern (interpolate ${'{branch}'} / ${'{sha}'})</option>
          <option value="fixed">fixed (single shared URL)</option>
          <option value="workflow_output">workflow_output (read from job output)</option>
        </select>
      </label>
      {c.urlResolution !== 'fixed' && c.urlResolution !== 'workflow_output' && (
        <Field
          label="URL pattern"
          value={c.urlPattern ?? ''}
          onChange={(v) => update({ urlPattern: v })}
          placeholder="https://${branch}.preview.example.com"
        />
      )}
      {c.urlResolution === 'fixed' && (
        <Field
          label="Fixed URL"
          value={c.urlFixed ?? ''}
          onChange={(v) => update({ urlFixed: v })}
          placeholder="https://dev.example.com"
        />
      )}
    </div>
  );
}

function JsonConfig({
  config,
  onChange,
  adapterId,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  adapterId: AdapterId;
}) {
  const [text, setText] = useState(JSON.stringify(config, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <label className="block text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">
          {adapterId} config (JSON)
        </span>
        <textarea
          className="mt-1 w-full rounded border bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          rows={8}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            try {
              onChange(JSON.parse(v));
              setParseError(null);
            } catch (err: any) {
              setParseError(String(err?.message ?? err));
            }
          }}
          spellCheck={false}
        />
      </label>
      <p className="text-xs text-zinc-500">
        Schema for {adapterId} varies — see the adapter's docs in the
        <code> @mergecrew/adapters-deploy</code> package.
      </p>
      {parseError && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{parseError}</p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="text-sm">
      <span className="block text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

function defaultConfig(adapterId: AdapterId): Record<string, unknown> {
  if (adapterId === 'github-actions') {
    return {
      installationId: '',
      repoFullName: '',
      workflowFilename: 'deploy-dev.yml',
      inputsTemplate: { branch: '${ref.branch}' },
      urlResolution: 'pattern',
      urlPattern: '',
    };
  }
  return {};
}
