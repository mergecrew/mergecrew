'use client';

import { useState, useTransition } from 'react';
import { Card, Button } from '@/components/ui';

type Kind = 'anthropic' | 'openai' | 'bedrock' | 'ollama';

interface Provider {
  id: string;
  kind: Kind;
  label: string;
  endpoint: string | null;
  hasCredential: boolean;
  capabilityOverrides: Record<string, unknown> | null;
}

interface SaveResult {
  ok: boolean;
  error?: string;
}

interface Props {
  providers: Provider[];
  canEdit: boolean;
  onCreate: (input: {
    kind: Kind;
    label: string;
    apiKey: string;
    endpoint: string;
    models: string[];
  }) => Promise<SaveResult>;
  onUpdate: (
    id: string,
    input: { label: string; endpoint: string | null; apiKey: string | null; models: string[] | null },
  ) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<SaveResult>;
}

export function LlmProvidersCard({ providers, canEdit, onCreate, onUpdate, onDelete }: Props) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const wrap = (fn: () => Promise<SaveResult>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Failed.');
    });
  };

  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">LLM providers</h2>
        {canEdit && !creating && (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
          >
            New provider
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {creating && (
        <ProviderForm
          mode="create"
          pending={pending}
          onSubmit={(v) =>
            wrap(async () => {
              const r = await onCreate(v);
              if (r.ok) setCreating(false);
              return r;
            })
          }
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="mt-3 space-y-2">
        {providers.map((p) => (
          <li key={p.id} className="rounded border p-3 dark:border-zinc-800">
            {editing === p.id ? (
              <ProviderForm
                mode="edit"
                pending={pending}
                initial={p}
                onSubmit={(v) =>
                  wrap(async () => {
                    const models = v.models.length > 0 ? v.models : null;
                    const r = await onUpdate(p.id, {
                      label: v.label,
                      endpoint: v.endpoint || null,
                      apiKey: v.apiKey === '' ? null : v.apiKey,
                      models,
                    });
                    if (r.ok) setEditing(null);
                    return r;
                  })
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-zinc-500">
                    {p.kind}
                    {p.endpoint ? ` · ${p.endpoint}` : ''}
                    {p.hasCredential ? ' · key set' : ' · no key'}
                  </div>
                  {modelsOf(p).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {modelsOf(p).map((m) => (
                        <span
                          key={m}
                          className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        setEditing(p.id);
                        setCreating(false);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        if (!confirm(`Delete provider "${p.label}"?`)) return;
                        wrap(() => onDelete(p.id));
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
        {providers.length === 0 && !creating && (
          <li className="text-sm text-zinc-500">
            No providers configured.{' '}
            {canEdit ? 'Click "New provider" to add one.' : 'Ask an admin to add one.'}
          </li>
        )}
      </ul>
    </Card>
  );
}

function modelsOf(p: Provider): string[] {
  const overrides = p.capabilityOverrides;
  const m = (overrides as { models?: unknown } | null)?.models;
  if (!Array.isArray(m)) return [];
  return m.filter((x): x is string => typeof x === 'string');
}

interface FormValues {
  kind: Kind;
  label: string;
  apiKey: string;
  endpoint: string;
  models: string[];
}

function ProviderForm({
  mode,
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: Provider;
  pending: boolean;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'anthropic');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [modelsCsv, setModelsCsv] = useState(modelsOf(initial ?? ({} as Provider)).join(', '));

  const submit = () => {
    const models = modelsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({ kind, label: label.trim(), apiKey, endpoint: endpoint.trim(), models });
  };

  return (
    <div className="space-y-3 rounded border p-3 dark:border-zinc-800">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Kind</span>
          <select
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            disabled={mode === 'edit'}
          >
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="bedrock">bedrock</option>
            <option value="ollama">ollama</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Label</span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. anthropic-prod"
          />
        </label>
      </div>
      {kind !== 'bedrock' && (
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            API key{' '}
            {mode === 'edit' && (
              <span className="text-xs text-zinc-400">— leave empty to keep current</span>
            )}
          </span>
          <input
            type="password"
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={kind === 'ollama' ? '(optional)' : 'sk-…'}
          />
        </label>
      )}
      {(kind === 'ollama' || kind === 'openai') && (
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            Endpoint{' '}
            <span className="text-xs text-zinc-400">
              ({kind === 'ollama' ? 'e.g. http://localhost:11434' : 'optional override'})
            </span>
          </span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
      )}
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Models <span className="text-xs text-zinc-400">(comma-separated, optional)</span>
        </span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          value={modelsCsv}
          onChange={(e) => setModelsCsv(e.target.value)}
          placeholder="claude-3-5-sonnet-20241022, claude-3-haiku-20240307"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={pending || !label.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}
