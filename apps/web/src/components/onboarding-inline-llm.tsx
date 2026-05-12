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
 * Other kinds require a non-empty API key; the action drops the
 * submit silently when empty, and the form prevents submit when the
 * required input is blank.
 */
export function InlineLlmStep({
  orgSlug,
  action,
}: {
  orgSlug: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('http://ollama:11434');
  const [pending, startTransition] = useTransition();
  const requiresKey = kind !== 'ollama';
  const canSubmit = requiresKey ? apiKey.trim().length > 0 : true;

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
          <option value="ollama">Ollama (local, no key)</option>
        </select>
      </div>

      {requiresKey ? (
        <div className="flex items-center gap-2">
          <label className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300" htmlFor="apiKey">
            API key
          </label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={kind === 'anthropic' ? 'sk-ant-…' : kind === 'openai' ? 'sk-…' : 'aws key'}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-600 dark:bg-zinc-800"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <label className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300" htmlFor="endpoint">
            Endpoint
          </label>
          <input
            id="endpoint"
            name="endpoint"
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-600 dark:bg-zinc-800"
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
