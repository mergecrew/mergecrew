'use client';

import { useState, useTransition } from 'react';
import { Camera } from 'lucide-react';
import { Card, Button } from '@/components/ui';

type Kind = 'anthropic' | 'openai' | 'bedrock' | 'ollama';

interface ModelCapability {
  vision?: boolean;
  tools?: boolean;
  embedding?: boolean;
  thinking?: boolean;
  parallelTools?: boolean;
  longContext?: number;
}

interface Provider {
  id: string;
  kind: Kind;
  label: string;
  endpoint: string | null;
  hasCredential: boolean;
  capabilityOverrides: Record<string, unknown> | null;
  modelCapabilities?: Record<string, ModelCapability>;
}

interface SaveResult {
  ok: boolean;
  error?: string;
}

interface TestResult {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  reply?: string;
  error?: string;
}

/** Bedrock only: the tenant's own AWS credentials (stored encrypted). */
export interface AwsCredentialFields {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
}

interface Props {
  providers: Provider[];
  canEdit: boolean;
  onCreate: (
    input: {
      kind: Kind;
      label: string;
      apiKey: string;
      endpoint: string;
      models: string[];
    } & Partial<AwsCredentialFields>,
  ) => Promise<SaveResult>;
  /** `apiKey` / AWS fields omitted = keep the stored credential. */
  onUpdate: (
    id: string,
    input: {
      label: string;
      endpoint: string | null;
      apiKey?: string;
      models: string[] | null;
    } & Partial<AwsCredentialFields>,
  ) => Promise<SaveResult>;
  onDelete: (id: string) => Promise<SaveResult>;
  onTest: (id: string) => Promise<TestResult>;
  onProbe: (id: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
}

export function LlmProvidersCard({
  providers,
  canEdit,
  onCreate,
  onUpdate,
  onDelete,
  onTest,
  onProbe,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult | 'pending'>>({});

  const runTest = (id: string) => {
    setTestResults((prev) => ({ ...prev, [id]: 'pending' }));
    startTransition(async () => {
      const r = await onTest(id);
      setTestResults((prev) => ({ ...prev, [id]: r }));
    });
  };

  const runProbe = (id: string) => {
    setError(null);
    startTransition(async () => {
      const r = await onProbe(id);
      if (!r.ok) setError(r.error ?? 'Probe failed.');
      else setError(`Probe found ${r.models?.length ?? 0} models. Reload to see them.`);
    });
  };

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
                      // Empty = keep the current credential (as the form says).
                      ...(v.apiKey !== '' ? { apiKey: v.apiKey } : {}),
                      ...(awsFieldsOf(v) ?? {}),
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
                    {p.kind === 'bedrock'
                      ? p.hasCredential
                        ? ' · AWS credentials set'
                        : ' · no AWS credentials'
                      : p.hasCredential
                        ? ' · key set'
                        : ' · no key'}
                  </div>
                  {modelsOf(p).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {modelsOf(p).map((m) => {
                        const cap = p.modelCapabilities?.[m];
                        return (
                          <span
                            key={m}
                            className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800"
                          >
                            {m}
                            {cap?.vision && (
                              <Camera
                                size={10}
                                aria-label="vision capable"
                                className="text-emerald-600 dark:text-emerald-400"
                              />
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={pending}
                      onClick={() => runTest(p.id)}
                    >
                      Test
                    </Button>
                    {p.kind === 'ollama' && p.endpoint && (
                      <Button
                        variant="secondary"
                        disabled={pending}
                        onClick={() => runProbe(p.id)}
                      >
                        Probe
                      </Button>
                    )}
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
            {testResults[p.id] && editing !== p.id && (
              <TestResultBadge result={testResults[p.id]!} />
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

function TestResultBadge({ result }: { result: TestResult | 'pending' }) {
  if (result === 'pending') {
    return (
      <div className="mt-2 rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        Pinging…
      </div>
    );
  }
  if (result.ok) {
    return (
      <div className="mt-2 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        ok · <span className="font-mono">{result.modelId}</span> · {result.latencyMs}ms
      </div>
    );
  }
  return (
    <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
      failed: {result.error}
    </div>
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
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
}

/** AWS fields to send, or null when the form left them blank (keep current). */
function awsFieldsOf(v: FormValues): AwsCredentialFields | null {
  if (v.kind !== 'bedrock') return null;
  if (!v.awsAccessKeyId && !v.awsSecretAccessKey) return null;
  return {
    awsAccessKeyId: v.awsAccessKeyId,
    awsSecretAccessKey: v.awsSecretAccessKey,
    awsRegion: v.awsRegion,
  };
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
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-1');

  // Bedrock: on create all three AWS fields are required; on edit they are
  // optional as a set (blank = keep the stored credentials).
  const awsPartial = awsAccessKeyId.trim() !== '' || awsSecretAccessKey.trim() !== '';
  const awsComplete =
    awsAccessKeyId.trim() !== '' && awsSecretAccessKey.trim() !== '' && awsRegion.trim() !== '';
  const awsOk = kind !== 'bedrock' || awsComplete || (mode === 'edit' && !awsPartial);
  const endpointOk = kind !== 'ollama' || endpoint.trim() !== '';

  const submit = () => {
    const models = modelsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({
      kind,
      label: label.trim(),
      apiKey: kind === 'bedrock' ? '' : apiKey,
      endpoint: endpoint.trim(),
      models,
      awsAccessKeyId: awsAccessKeyId.trim(),
      awsSecretAccessKey: awsSecretAccessKey.trim(),
      awsRegion: awsRegion.trim(),
    });
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
      {kind === 'bedrock' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="block text-zinc-600 dark:text-zinc-400">AWS access key ID</span>
              <input
                className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
                value={awsAccessKeyId}
                onChange={(e) => setAwsAccessKeyId(e.target.value)}
                placeholder="AKIA…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-zinc-600 dark:text-zinc-400">AWS secret access key</span>
              <input
                type="password"
                className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
                value={awsSecretAccessKey}
                onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-zinc-600 dark:text-zinc-400">AWS region</span>
              <input
                className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
                value={awsRegion}
                onChange={(e) => setAwsRegion(e.target.value)}
                placeholder="us-east-1"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            Model calls are authorised by and billed to this AWS account. Use an IAM user scoped to{' '}
            <code>bedrock:InvokeModel*</code>.
            {mode === 'edit' && ' Leave the key fields empty to keep the stored credentials.'}
          </p>
        </div>
      )}
      {(kind === 'ollama' || kind === 'openai') && (
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            Endpoint{' '}
            <span className="text-xs text-zinc-400">
              ({kind === 'ollama' ? 'e.g. https://ollama.example.com' : 'optional override'})
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
        <Button
          variant="primary"
          onClick={submit}
          disabled={pending || !label.trim() || !awsOk || !endpointOk}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
