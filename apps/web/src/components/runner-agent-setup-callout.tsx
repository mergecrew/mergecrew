'use client';

import { useState } from 'react';

/**
 * One-time-display callout shown right after a runner-agent token is
 * issued. Renders both the bare token AND a ready-to-paste `docker
 * run` command with the token + agent name + API URL already
 * interpolated. The bare token stays for operators who prefer to
 * compose their own startup command (systemd unit, custom compose
 * block, etc.); the full command is the happy-path "copy + paste on
 * the host" affordance the bare callout was missing.
 *
 * After the 60-second cookie expires (see runner-agents/page.tsx) the
 * only way to recover either is to revoke + re-issue.
 */
export function RunnerAgentSetupCallout({
  token,
  agentName,
  apiUrl,
}: {
  token: string;
  agentName: string;
  apiUrl: string;
}) {
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Two backslashes per line because we want the rendered string to
  // contain a literal backslash followed by a newline (shell line-
  // continuation), and the source-string escape doubles them.
  const command = `docker run -d --restart unless-stopped \\
  --name mergecrew-agent \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  ghcr.io/mergecrew/runner-agent:latest \\
    --token ${token} \\
    --api-url ${apiUrl} \\
    --name ${agentName} \\
    --driver docker \\
    --concurrency 2`;

  async function copy(text: string, setter: (v: boolean) => void) {
    await navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 1500);
  }

  return (
    <div className="border border-warn bg-warn/20 p-3 text-sm">
      <div className="font-medium text-ink">
        Runner-agent token for &quot;{agentName}&quot;
      </div>
      <p className="mt-1 text-ink">
        Shown <strong>exactly once</strong>. Copy the full setup command below and run it
        on the host that will execute this org&apos;s sandboxes (your EC2 box, GCP VM, GHA
        self-hosted runner, homelab — anywhere with Docker + outbound HTTPS). If you lose
        it, revoke this agent from the list below and enrol a new one.
      </p>

      <div className="mt-3">
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          Full setup command (token + API URL + agent name pre-filled)
        </div>
        <div className="mt-1 flex items-start gap-2">
          <pre className="flex-1 overflow-auto rounded bg-white px-2 py-1.5 font-mono text-[11px] leading-relaxed">
            {command}
          </pre>
          <button
            type="button"
            className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-bg-2"
            onClick={() => copy(command, setCopiedCmd)}
          >
            {copiedCmd ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          Just the token (for custom systemd / compose setups)
        </div>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs">
            {token}
          </code>
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs hover:bg-bg-2"
            onClick={() => copy(token, setCopiedToken)}
          >
            {copiedToken ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
