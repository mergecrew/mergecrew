'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { runInceptionAction } from './settings-actions';

interface DetectedFramework {
  kind: string;
  label: string;
  version?: string;
  evidence: string;
}
interface DetectedScript {
  name: string;
  cmd: string;
  kind: string;
}
interface DetectedWorkflow {
  path: string;
  events: string[];
  isDeployCandidate: boolean;
  acceptsCorrelationId: boolean;
}
interface InceptionResult {
  summary: {
    frameworks: DetectedFramework[];
    scripts: DetectedScript[];
    workflows: DetectedWorkflow[];
  };
  draftYaml: string;
}

/**
 * V1.1 Project Inception trigger (#7).
 *
 * Renders an "Analyze repository" button. On click, calls the API which
 * clones the repo and runs the detector, then shows:
 *   - structured findings (frameworks, scripts, workflow candidates)
 *   - the draft mergecrew.yaml in a copy-friendly textarea
 *
 * Disabled when there's no connected repo — the section's description
 * tells the user to connect one first.
 */
export function InceptionForm({
  slug,
  projectSlug,
  hasRepo,
}: {
  slug: string;
  projectSlug: string;
  hasRepo: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<InceptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onRun = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await runInceptionAction(slug, projectSlug);
        setResult(r as InceptionResult);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  if (!hasRepo) {
    return (
      <p className="text-sm text-zinc-500">
        Connect a repository above first. Inception clones the repo (read-only)
        and detects the stack so the setup wizard can pre-fill defaults.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Button onClick={onRun} disabled={pending} variant="primary">
          {pending ? 'Analyzing…' : result ? 'Re-analyze' : 'Analyze repository'}
        </Button>
        <p className="mt-2 text-xs text-zinc-500">
          Clones the repo into a temp workspace, scans for frameworks, scripts,
          and deploy workflows. No writes.
        </p>
      </div>

      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <Findings result={result} />
          <details className="rounded border p-2 text-sm dark:border-zinc-800">
            <summary className="cursor-pointer font-medium">
              Draft mergecrew.yaml
            </summary>
            <textarea
              readOnly
              spellCheck={false}
              className="mt-2 w-full rounded border bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              rows={20}
              value={result.draftYaml}
            />
            <p className="mt-1 text-xs text-zinc-500">
              Copy this into <code>mergecrew.yaml</code> at the repo root. The
              first daily run will pick it up automatically.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}

function Findings({ result }: { result: InceptionResult }) {
  const { frameworks, scripts, workflows } = result.summary;
  const deployCandidates = workflows.filter((w) => w.isDeployCandidate);
  const otherWorkflows = workflows.filter((w) => !w.isDeployCandidate);

  return (
    <div className="grid gap-3 text-sm sm:grid-cols-3">
      <Card title={`Stack (${frameworks.length})`}>
        {frameworks.length === 0 ? (
          <Empty>No frameworks detected.</Empty>
        ) : (
          <ul className="space-y-1">
            {frameworks.map((f) => (
              <li key={f.kind}>
                <span className="font-medium">{f.label}</span>
                <span className="block text-xs text-zinc-500">{f.evidence}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Scripts (${scripts.length})`}>
        {scripts.length === 0 ? (
          <Empty>No package.json scripts.</Empty>
        ) : (
          <ul className="space-y-1">
            {scripts
              .filter((s) => s.kind !== 'unknown')
              .map((s) => (
                <li key={s.name}>
                  <span className="font-mono text-xs text-zinc-500">{s.kind}</span>{' '}
                  <span className="font-medium">{s.name}</span>
                  <span className="block truncate font-mono text-xs text-zinc-500">
                    {s.cmd}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card
        title={`Deploy candidates (${deployCandidates.length})`}
        sub={otherWorkflows.length > 0 ? `+ ${otherWorkflows.length} other workflow(s)` : undefined}
      >
        {deployCandidates.length === 0 ? (
          <Empty>None — wizard will scaffold one.</Empty>
        ) : (
          <ul className="space-y-1">
            {deployCandidates.map((w) => (
              <li key={w.path}>
                <span className="font-mono text-xs">{w.path}</span>
                <span className="block text-xs text-zinc-500">
                  triggers: {w.events.join(', ')}
                </span>
                {!w.acceptsCorrelationId && (
                  <span className="block text-xs text-amber-600 dark:text-amber-400">
                    no <code>mergecrew_correlation_id</code> input — wizard will offer to add it
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded border p-2 dark:border-zinc-800">
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      {sub && <div className="text-xs text-zinc-400">{sub}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-zinc-400">{children}</span>;
}
