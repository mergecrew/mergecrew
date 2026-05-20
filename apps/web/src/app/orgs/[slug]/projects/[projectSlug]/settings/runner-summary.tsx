'use client';

/**
 * Read-only summary of the project's runner.* config (#576-derived UI
 * discoverability pass). Shows operators *what their sandbox looks
 * like* — image, resources, setup, cache, egress — alongside concrete
 * copy-paste YAML examples for each setting so they don't have to dig
 * through the docs to flip one knob.
 *
 * Edits go through the lifecycle YAML editor (linked at the bottom of
 * the card). A future iteration may add dedicated forms for the
 * egress allowlist (the only field that lives in a Project column) +
 * a sandbox-driver-mode indicator surfaced from the supervisor's
 * RUNNER_SANDBOX env.
 */

import Link from 'next/link';

interface RunnerConfig {
  image?: string;
  resources?: {
    cpu?: number;
    memoryMb?: number;
    timeoutMs?: number;
    pids?: number;
  };
  setup?: {
    commands?: string[];
  };
  cache?: {
    paths?: string[];
  };
  egress?: {
    allow?: string[];
  };
}

const EXAMPLES: Array<{ title: string; description: string; yaml: string }> = [
  {
    title: 'Pin a specific runner image',
    description:
      'Use a stock image (`mergecrew/runner-python:3.12`) or a BYO `ghcr.io/your-org/runner:tag`. Private registries authenticate via `runner.imagePullSecret` (see docs).',
    yaml: `runner:\n  image: ghcr.io/mergecrew/runner-polyglot:latest`,
  },
  {
    title: 'Tighten resource limits',
    description: 'Per-run CPU + memory + wall-clock ceiling. The driver enforces these.',
    yaml: `runner:\n  resources:\n    cpu: 2\n    memoryMb: 2048\n    timeoutMs: 600000`,
  },
  {
    title: 'Setup script (runs once before agents)',
    description:
      'Idempotent commands run inside the sandbox at the top of each run. Use this for one-time toolchain pulls — mise installs (`.tool-versions`) and Poetry/uv/pip installs are auto-detected so you usually do not need to script them.',
    yaml: `runner:\n  setup:\n    commands:\n      - corepack enable\n      - pnpm config set store-dir /workspace/.pnpm-store`,
  },
  {
    title: 'Cache mounts (persist between runs)',
    description:
      'Per-project directories that survive across sandbox lifetimes. Tagged on the host by (org, project) so they never cross tenant boundaries.',
    yaml: `runner:\n  cache:\n    paths:\n      - ~/.cache/pnpm\n      - ~/.cache/pip\n      - ./.next/cache`,
  },
  {
    title: 'Hostname egress allowlist',
    description:
      'Per-project hostname allowlist. Used by HTTP-bound skills and (when the docker/k8s/fargate/e2b driver is configured) by the per-run network namespace + DNS resolver. `*.example.com` matches strict subdomains; `*` is explicit allow-all.',
    yaml: `runner:\n  egress:\n    allow:\n      - api.github.com\n      - "*.npmjs.org"\n      - "*.pypi.org"`,
  },
];

function fmtList(items: string[] | undefined, empty: string): string {
  if (!items || items.length === 0) return empty;
  return items.join(', ');
}

function fmtDurationMs(ms: number | undefined): string {
  if (!ms) return 'unset';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function RunnerSummary({
  orgSlug,
  projectSlug,
  runner,
}: {
  orgSlug: string;
  projectSlug: string;
  runner: RunnerConfig | null;
}) {
  const lifecycleHref = `/orgs/${orgSlug}/projects/${projectSlug}/lifecycle`;
  if (!runner) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This project has no <code className="font-mono text-xs">runner.*</code> config in
          mergecrew.yaml — the sandbox uses the supervisor defaults (default polyglot image, no
          allowlist, no setup script, no caches).
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          To customize, edit <Link className="underline decoration-dotted" href={lifecycleHref}>your
          lifecycle YAML</Link>. Common patterns below.
        </p>
        <Examples />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <tbody>
          <Row label="Image" value={runner.image ?? '(supervisor default — runner-polyglot)'} />
          <Row label="CPU" value={runner.resources?.cpu != null ? String(runner.resources.cpu) : 'unset (host default)'} />
          <Row
            label="Memory"
            value={
              runner.resources?.memoryMb != null
                ? `${runner.resources.memoryMb} MB`
                : 'unset (host default)'
            }
          />
          <Row label="Wall clock" value={fmtDurationMs(runner.resources?.timeoutMs)} />
          <Row label="Setup commands" value={fmtList(runner.setup?.commands, '(none)')} />
          <Row label="Cache paths" value={fmtList(runner.cache?.paths, '(none)')} />
          <Row label="Egress allowlist" value={fmtList(runner.egress?.allow, '(none — sandbox blocks all)')} />
        </tbody>
      </table>
      <p className="text-xs text-zinc-500">
        Edit these values from <Link className="underline decoration-dotted" href={lifecycleHref}>your
        lifecycle YAML</Link>. The supervisor's sandbox driver mode (process / docker / kubernetes
        / fargate / e2b) is configured via the <code className="font-mono">RUNNER_SANDBOX</code>{' '}
        env on the runner deployment — see{' '}
        <a
          className="underline decoration-dotted"
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/16-self-host-runbook.md"
          target="_blank"
          rel="noreferrer"
        >
          self-host runbook
        </a>
        .
      </p>
      <Examples />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-t border-zinc-100 align-baseline dark:border-zinc-800">
      <td className="py-2 pr-4 text-xs uppercase tracking-wide text-zinc-500">{label}</td>
      <td className="py-2 font-mono text-zinc-800 dark:text-zinc-200">{value}</td>
    </tr>
  );
}

function Examples() {
  return (
    <details>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        Common runner.* config patterns ({EXAMPLES.length})
      </summary>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {EXAMPLES.map((ex) => (
          <div
            key={ex.title}
            className="rounded border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <div className="text-sm font-medium">{ex.title}</div>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{ex.description}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {ex.yaml}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
