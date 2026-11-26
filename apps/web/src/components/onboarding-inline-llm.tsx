'use client';

import { useState, useTransition } from 'react';

type Kind = 'anthropic' | 'openai' | 'bedrock' | 'ollama';

/**
 * Inline "add an LLM provider" form for the onboarding wizard
 * (#385). Submitted to the server action defined in the wizard page,
 * which POSTs to `/v1/orgs/{slug}/llm/providers` and revalidates the
 * page so the step row flips from pending → complete.
 *
 * Ollama is the no-key path — the endpoint URL is the credential.
 * Bedrock takes the tenant's own AWS access key ID + secret + region
 * (stored encrypted; never the deployment's credentials). Other kinds
 * require a non-empty API key; the action drops the submit silently
 * when required input is missing, and the form prevents submit when the
 * required inputs are blank.
 *
 * The Ollama endpoint is only pre-filled with the compose sidecar
 * address in development builds — on a hosted deployment that address
 * is not the tenant's server.
 */
const DEFAULT_OLLAMA_ENDPOINT = process.env.NODE_ENV === 'production' ? '' : 'http://ollama:11434';

export function InlineLlmStep({
  orgSlug,
  action,
}: {
  orgSlug: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(DEFAULT_OLLAMA_ENDPOINT);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [pending, startTransition] = useTransition();
  const requiresKey = kind === 'anthropic' || kind === 'openai';
  const canSubmit =
    kind === 'ollama'
      ? endpoint.trim().length > 0
      : kind === 'bedrock'
        ? awsAccessKeyId.trim().length > 0 &&
          awsSecretAccessKey.trim().length > 0 &&
          awsRegion.trim().length > 0
        : apiKey.trim().length > 0;
  const inputClass =
    'flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-600 dark:bg-zinc-800';
  const labelClass = 'w-20 shrink-0 text-zinc-600 dark:text-zinc-300';

  return (
    <form
      action={(fd) => {
        fd.set('slug', orgSlug);
        startTransition(async () => {
          await action(fd);
        });
      }}
      className="space-y-3 rounded-md border border-zinc-200 bg-white/60 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/40"
    >
      <div className="flex items-center gap-2">
        <label className="shrink-0 text-zinc-600 dark:text-zinc-300" htmlFor="kind">
          Provider
        </label>
        <select
          id="kind"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-600 dark:bg-zinc-800"
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="bedrock">AWS Bedrock</option>
          <option value="ollama">Ollama (self-hosted, no key)</option>
        </select>
      </div>

      {requiresKey && (
        <div className="flex items-center gap-2">
          <label className={labelClass} htmlFor="apiKey">
            API key
          </label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      {kind === 'bedrock' && (
        <>
          <div className="flex items-center gap-2">
            <label className={labelClass} htmlFor="awsAccessKeyId">
              Access key ID
            </label>
            <input
              id="awsAccessKeyId"
              name="awsAccessKeyId"
              value={awsAccessKeyId}
              onChange={(e) => setAwsAccessKeyId(e.target.value)}
              placeholder="AKIA…"
              className={`${inputClass} font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className={labelClass} htmlFor="awsSecretAccessKey">
              Secret key
            </label>
            <input
              id="awsSecretAccessKey"
              name="awsSecretAccessKey"
              type="password"
              value={awsSecretAccessKey}
              onChange={(e) => setAwsSecretAccessKey(e.target.value)}
              className={inputClass}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className={labelClass} htmlFor="awsRegion">
              Region
            </label>
            <input
              id="awsRegion"
              name="awsRegion"
              value={awsRegion}
              onChange={(e) => setAwsRegion(e.target.value)}
              placeholder="us-east-1"
              className={`${inputClass} font-mono`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Use an IAM user scoped to <code>bedrock:InvokeModel*</code>. Model calls are billed to this
            AWS account.
          </p>
        </>
      )}

      {kind === 'ollama' && (
        <div className="flex items-center gap-2">
          <label className={labelClass} htmlFor="endpoint">
            Endpoint
          </label>
          <input
            id="endpoint"
            name="endpoint"
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://ollama.example.com"
            className={inputClass}
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={!canSubmit || pending}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-700 disabled:opacity-50 disabled:hover:bg-sky-600"
        >
          {pending ? 'Saving…' : 'Save provider'}
        </button>
      </div>
    </form>
  );
}
