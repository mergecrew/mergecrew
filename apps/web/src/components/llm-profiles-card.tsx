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
  /**
   * Flat list of `providerKind/modelId` refs derived from the org's
   * registered providers + their declared models. The preference-order
   * editor uses this to populate its "add ref" picker so the operator
   * doesn't have to retype refs (#268).
   */
  availableRefs?: string[];
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

export function LlmProfilesCard({ profiles, availableRefs = [], canEdit, onCreate, onUpdate, onDelete }: Props) {
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
          availableRefs={availableRefs}
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
                availableRefs={availableRefs}
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
  availableRefs,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: Profile;
  pending: boolean;
  availableRefs: string[];
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [preferenceOrder, setPreferenceOrder] = useState<string[]>(initial?.preferenceOrder ?? []);
  const [pickerValue, setPickerValue] = useState('');
  const [routingJson, setRoutingJson] = useState(
    JSON.stringify(initial?.capabilityRouting ?? {}, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  const remainingRefs = availableRefs.filter((r) => !preferenceOrder.includes(r));

  const addRef = (ref: string) => {
    const trimmed = ref.trim();
    if (!trimmed || preferenceOrder.includes(trimmed)) return;
    setPreferenceOrder((prev) => [...prev, trimmed]);
    setPickerValue('');
  };
  const removeRef = (i: number) => {
    setPreferenceOrder((prev) => prev.filter((_, idx) => idx !== i));
  };
  const moveRef = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= preferenceOrder.length) return;
    setPreferenceOrder((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const submit = () => {
    setParseError(null);

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
      <div className="block text-sm">
        <div className="text-zinc-600 dark:text-zinc-400">
          Preference order{' '}
          <span className="text-xs text-zinc-400">
            — the router walks this list per request; first available + capable wins
          </span>
        </div>
        {preferenceOrder.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">
            No models selected. Pick from the dropdown below to add one.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {preferenceOrder.map((ref, i) => (
              <li
                key={ref + i}
                className="flex items-center gap-2 rounded border px-2 py-1 dark:border-zinc-800"
              >
                <span className="w-6 font-mono text-xs text-zinc-500">{i + 1}.</span>
                <span className="flex-1 font-mono text-xs">{ref}</span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => moveRef(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label={`Move ${ref} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => moveRef(i, 1)}
                  disabled={i === preferenceOrder.length - 1}
                  title="Move down"
                  aria-label={`Move ${ref} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/30 dark:hover:text-rose-300"
                  onClick={() => removeRef(i)}
                  title="Remove"
                  aria-label={`Remove ${ref}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          {remainingRefs.length > 0 ? (
            <select
              className="flex-1 rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
            >
              <option value="">— add a model —</option>
              {remainingRefs.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="flex-1 rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
              value={pickerValue}
              onChange={(e) => setPickerValue(e.target.value)}
              placeholder={
                availableRefs.length === 0
                  ? 'register an LLM provider first, or type a ref manually (provider/model)'
                  : 'all available models added — type a ref manually if needed'
              }
            />
          )}
          <Button variant="secondary" onClick={() => addRef(pickerValue)} disabled={!pickerValue.trim()}>
            Add
          </Button>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
          Per-agent capability routing (advanced, raw JSON)
        </summary>
        <textarea
          className="mt-2 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={6}
          value={routingJson}
          onChange={(e) => setRoutingJson(e.target.value)}
          placeholder='{ "planner": { "tools": true, "longContext": 200000 } }'
        />
        <p className="mt-1 text-xs text-zinc-500">
          Optional. Object keyed by agent ref; value is a partial <code>ModelCapability</code>.
        </p>
      </details>
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
