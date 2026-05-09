'use client';

import { useState, useTransition } from 'react';
import { Card, Button } from '@/components/ui';

interface Profile {
  id: string;
  name: string;
  preferenceOrder: string[];
  capabilityRouting: Record<string, unknown>;
}

interface SaveResult {
  ok: boolean;
  error?: string;
}

interface Props {
  profiles: Profile[];
  canEdit: boolean;
  onCreate: (input: {
    name: string;
    preferenceOrder: string[];
    capabilityRouting: Record<string, unknown>;
  }) => Promise<SaveResult>;
  onUpdate: (
    id: string,
    input: {
      name: string;
      preferenceOrder: string[];
      capabilityRouting: Record<string, unknown>;
    },
  ) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<SaveResult>;
}

export function LlmProfilesCard({ profiles, canEdit, onCreate, onUpdate, onDelete }: Props) {
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
        <div>
          <h2 className="font-medium">LLM profiles</h2>
          <p className="text-xs text-zinc-500">
            Ordered list of <code>provider/model</code> refs the router walks for each capability.
            The first available + capable provider wins.
          </p>
        </div>
        {canEdit && !creating && (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
          >
            New profile
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {creating && (
        <ProfileForm
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
        {profiles.map((p) => (
          <li key={p.id} className="rounded border p-3 dark:border-zinc-800">
            {editing === p.id ? (
              <ProfileForm
                mode="edit"
                pending={pending}
                initial={p}
                onSubmit={(v) =>
                  wrap(async () => {
                    const r = await onUpdate(p.id, v);
                    if (r.ok) setEditing(null);
                    return r;
                  })
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium">{p.name}</div>
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
                          if (!confirm(`Delete profile "${p.name}"?`)) return;
                          wrap(() => onDelete(p.id));
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.preferenceOrder.map((ref, i) => (
                    <span
                      key={ref + i}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800"
                    >
                      {i + 1}. {ref}
                    </span>
                  ))}
                  {p.preferenceOrder.length === 0 && (
                    <span className="text-xs text-zinc-500">(empty preference order)</span>
                  )}
                </div>
                {Object.keys(p.capabilityRouting).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                      Per-agent capability overrides
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                      {JSON.stringify(p.capabilityRouting, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </li>
        ))}
        {profiles.length === 0 && !creating && (
          <li className="text-sm text-zinc-500">
            No profiles yet.{' '}
            {canEdit ? 'Click "New profile" to add one.' : 'Ask an admin to add one.'}
          </li>
        )}
      </ul>
    </Card>
  );
}

interface FormValues {
  name: string;
  preferenceOrder: string[];
  capabilityRouting: Record<string, unknown>;
}

function ProfileForm({
  mode,
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: Profile;
  pending: boolean;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [preferenceCsv, setPreferenceCsv] = useState((initial?.preferenceOrder ?? []).join('\n'));
  const [routingJson, setRoutingJson] = useState(
    JSON.stringify(initial?.capabilityRouting ?? {}, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  const submit = () => {
    setParseError(null);
    const preferenceOrder = preferenceCsv
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    let capabilityRouting: Record<string, unknown> = {};
    if (routingJson.trim()) {
      try {
        const parsed = JSON.parse(routingJson);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          throw new Error('expected an object');
        }
        capabilityRouting = parsed;
      } catch (e: any) {
        setParseError(`capabilityRouting: ${e?.message ?? e}`);
        return;
      }
    }

    onSubmit({ name: name.trim(), preferenceOrder, capabilityRouting });
  };

  return (
    <div className="space-y-3 rounded border p-3 dark:border-zinc-800">
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Name</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. default"
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Preference order{' '}
          <span className="text-xs text-zinc-400">— one <code>provider/model</code> per line</span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={5}
          value={preferenceCsv}
          onChange={(e) => setPreferenceCsv(e.target.value)}
          placeholder="anthropic/claude-3-5-sonnet-20241022&#10;openai/gpt-4o-mini"
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Per-agent capability routing (JSON, optional)
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={6}
          value={routingJson}
          onChange={(e) => setRoutingJson(e.target.value)}
          placeholder='{ "planner": { "tools": true, "longContext": 200000 } }'
        />
      </label>
      {parseError && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {parseError}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={pending || !name.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}
