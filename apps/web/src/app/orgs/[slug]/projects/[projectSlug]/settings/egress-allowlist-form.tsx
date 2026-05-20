'use client';

/**
 * Per-project egress allowlist editor (#10 / #576 surface).
 *
 * The list is stored on the Project row (\`egress_allowlist\` jsonb).
 * Skills check it before every HTTP call; the docker/k8s/fargate/e2b
 * drivers also push it through to the per-run network namespace + DNS
 * resolver so the sandbox can't reach hosts outside the list.
 *
 * Semantics (matching packages/skills/src/egress-policy.ts):
 *   - \`null\` (UI: "unrestricted") = back-compat default, no check.
 *   - \`[]\` = block all outbound HTTP.
 *   - \`['*']\` = explicit allow-all (still blocks loopback / RFC1918).
 *   - otherwise: each entry matches by exact host or \`*.suffix\` strict
 *     subdomain.
 */

import { useState, useTransition } from 'react';
import { updateProjectAction } from './settings-actions';

const COMMON_PATTERNS = [
  'api.github.com',
  'objects.githubusercontent.com',
  '*.npmjs.org',
  '*.pypi.org',
  '*.pythonhosted.org',
  '*.docker.io',
  'proxy.golang.org',
  '*.crates.io',
];

export function EgressAllowlistForm({
  slug,
  projectSlug,
  initial,
  canEdit,
}: {
  slug: string;
  projectSlug: string;
  initial: string[] | null;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<string[] | null>(initial);
  const [pending, startTransition] = useTransition();
  const [textValue, setTextValue] = useState((initial ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);

  const restricted = draft !== null;

  function save(next: string[] | null) {
    setError(null);
    startTransition(async () => {
      try {
        await updateProjectAction(slug, projectSlug, { egressAllowlist: next });
        setDraft(next);
        setTextValue((next ?? []).join('\n'));
      } catch (e: any) {
        setError(String(e?.message ?? 'failed to save'));
      }
    });
  }

  function toggleMode() {
    if (!canEdit) return;
    save(restricted ? null : []);
  }

  function applyTextarea() {
    const lines = textValue
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    save(lines);
  }

  function addPattern(p: string) {
    const lines = textValue
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.includes(p)) return;
    const next = [...lines, p];
    setTextValue(next.join('\n'));
    save(next);
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={restricted}
          onChange={toggleMode}
          disabled={pending || !canEdit}
        />
        <span>
          <span className="font-medium">Restrict outbound network to an allowlist</span>
          <span className="block text-zinc-600 dark:text-zinc-400">
            When off, skills + sandboxes reach any public host (back-compat default). When on, only
            the hosts you list below are reachable; everything else is blocked at the skill layer
            and (for docker / k8s / fargate / e2b drivers) at the per-run network namespace.
          </span>
        </span>
      </label>

      {restricted && (
        <div className="space-y-2 rounded border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Allowed hosts (one per line)
          </label>
          <textarea
            className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
            rows={Math.max(5, Math.min(15, (textValue.split('\n').length || 0) + 1))}
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            disabled={pending || !canEdit}
            placeholder={'api.github.com\n*.npmjs.org\n*.pypi.org'}
          />
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <p className="text-zinc-500">
              Exact match (<code>api.github.com</code>) or wildcard suffix (
              <code>*.pypi.org</code>, matches strict subdomains only). <code>*</code> is explicit
              allow-all. Loopback + RFC1918 are always blocked.
            </p>
            <button
              type="button"
              onClick={applyTextarea}
              disabled={pending || !canEdit}
              className="rounded bg-accent px-2.5 py-1 text-xs text-accent-fg hover:opacity-90 disabled:opacity-40"
            >
              Save list
            </button>
          </div>
          <div className="border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
            <div className="mb-1 text-zinc-500">Common patterns — click to add:</div>
            <div className="flex flex-wrap gap-1">
              {COMMON_PATTERNS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => addPattern(p)}
                  disabled={pending || !canEdit}
                  className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  + {p}
                </button>
              ))}
            </div>
          </div>
          {draft?.length === 0 && (
            <p className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              The allowlist is empty — <strong>all outbound HTTP is blocked</strong>. Add at least
              one pattern to allow skills + sandboxes to reach the network.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
