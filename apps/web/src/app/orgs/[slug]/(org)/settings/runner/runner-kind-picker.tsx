'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui';

/**
 * Client-side runner profile picker (#846).
 *
 * Lives inside the server `<form action={updateProfileAction}>` on the
 * runner-profile page and owns the *currently-selected* kind in React
 * state — so clicking a radio reactively opens the matching setup
 * `<details>` panel without a save+reload roundtrip. The form Save
 * button still submits the regular HTML form; all the inline `<input>`
 * fields (Fargate config, GitHub config) serialize the same way they
 * did when this was a server component.
 *
 * Constants `KIND_LABEL` / `KIND_DESC` moved into this file from
 * page.tsx so they can be referenced without prop-drilling.
 */
export type ProfileKind =
  | 'none'
  | 'instance_builtin'
  | 'agent'
  | 'fargate_byo'
  | 'github_actions';

export const KIND_LABEL: Record<ProfileKind, string> = {
  none: 'None',
  instance_builtin: 'Instance built-in',
  agent: 'BYO agent',
  fargate_byo: 'AWS Fargate (your account)',
  github_actions: 'GitHub Actions',
};

export const KIND_DESC: Record<ProfileKind, string> = {
  none: 'Runs are blocked until you pick a runner profile.',
  instance_builtin:
    "Use the deployment's built-in runner. Available only to orgs the operator has trusted (MERGECREW_TRUSTED_ORG_SLUGS).",
  agent:
    'Run the `mergecrew/runner-agent` container on your own machine or cloud account. The agent pulls jobs over HTTPS and executes them locally.',
  fargate_byo:
    'Execute steps as ECS tasks in your own AWS account via STS role assumption. No long-lived AWS keys are stored.',
  github_actions:
    'Dispatch steps to a workflow_dispatch trigger in a repo you own. The agent runs inside a GitHub-hosted runner; you pay for nothing on the deployment side.',
};

const ALL_KINDS: ProfileKind[] = [
  'none',
  'instance_builtin',
  'agent',
  'fargate_byo',
  'github_actions',
];

interface ProfileShape {
  kind: ProfileKind;
  isTrustedForInstanceBuiltin: boolean;
  awsRoleArn: string | null;
  awsExternalId: string | null;
  awsRegion: string | null;
  fargateCluster: string | null;
  fargateTaskDefinition: string | null;
  fargateSubnets: string[];
  fargateSecurityGroups: string[];
  githubRepoFullName: string | null;
  githubWorkflowFileName: string | null;
  githubTokenConfigured: boolean;
}

export function RunnerKindPicker({
  slug,
  profile,
  publicBaseUrl,
  trustPolicySnippet,
}: {
  slug: string;
  profile: ProfileShape;
  publicBaseUrl: string;
  trustPolicySnippet: string;
}) {
  const [selectedKind, setSelectedKind] = useState<ProfileKind>(profile.kind);

  return (
    <div className="space-y-3 text-sm">
      <input type="hidden" name="slug" value={slug} />

      <div className="space-y-2">
        {ALL_KINDS.map((k) => {
          const disabled =
            k === 'instance_builtin' && !profile.isTrustedForInstanceBuiltin;
          return (
            <label
              key={k}
              className={`flex items-start gap-3 rounded border p-3 ${
                disabled
                  ? 'opacity-50 cursor-not-allowed'
                  : 'cursor-pointer hover:border-accent'
              } ${
                selectedKind === k
                  ? 'border-accent'
                  : 'border-zinc-200 dark:border-zinc-700'
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={selectedKind === k}
                onChange={() => setSelectedKind(k)}
                disabled={disabled}
                className="mt-1"
              />
              <div>
                <div className="font-medium">
                  {KIND_LABEL[k]}
                  {disabled && (
                    <span className="ml-2 text-xs text-zinc-500">
                      (not trusted — contact operator)
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">{KIND_DESC[k]}</div>
              </div>
            </label>
          );
        })}
      </div>

      <details
        open={selectedKind === 'agent'}
        className="text-xs text-zinc-500"
      >
        <summary className="cursor-pointer">
          BYO agent setup (required for the <code>agent</code> kind)
        </summary>
        <div className="mt-2 space-y-3">
          <p>
            Run the <code>mergecrew/runner-agent</code> container on any host with
            Docker and outbound HTTPS — AWS EC2, GCP / Hetzner / Linode / DO VM,
            on-prem, homelab, or even an existing GitHub Actions self-hosted runner
            box. The agent pulls jobs over long-poll and executes them locally; the
            deployment opens <strong>no inbound connection</strong> to your host.
          </p>

          <div className="rounded border border-accent/30 bg-accent/5 p-2 text-ink">
            <p className="m-0">
              <strong>The ready-to-paste command lives on the next page.</strong>{' '}
              Save this profile choice, then go to{' '}
              <Link
                href={`/orgs/${slug}/settings/runner-agents`}
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Settings → Agent tokens
              </Link>{' '}
              and issue a token — that page renders the same{' '}
              <code>docker run</code> block with your real secret already
              interpolated (one-time-display). The sketch below is identical
              except the secret placeholder.
            </p>
          </div>

          <ol className="list-decimal space-y-2 pl-4">
            <li>
              Pick <strong>BYO agent</strong> above and click <strong>Save</strong>.
            </li>
            <li>
              Go to{' '}
              <Link
                href={`/orgs/${slug}/settings/runner-agents`}
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Settings → Agent tokens
              </Link>
              , click <strong>Enrol agent</strong>, give it a host-recognisable
              name (e.g. <code>ec2-runner-1</code>), and copy the full setup
              command from the callout that appears.
            </li>
            <li>
              On the host (your EC2 box, your GHA VM, whatever has docker), paste
              that command. The sketch:
              <pre className="mt-2 overflow-auto rounded bg-zinc-50 p-3 text-[11px] text-ink dark:bg-zinc-900 dark:text-zinc-200">
{`docker run -d --restart unless-stopped \\
  --name mergecrew-agent \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  ghcr.io/mergecrew/runner-agent:latest \\
    --token mca_${slug}_<paste-from-step-2> \\
    --api-url ${publicBaseUrl} \\
    --name ec2-runner-1 \\
    --driver docker \\
    --concurrency 2`}
              </pre>
            </li>
            <li>
              Within ~30 seconds the agent shows up under <strong>Enrolled agents</strong>{' '}
              below with an <em>online</em> badge. New runs for this org will
              dispatch to it.
            </li>
          </ol>

          <p>
            <strong>Where can it run?</strong> Anywhere reachable by outbound HTTPS
            to this deployment&apos;s API. Concretely: any AWS EC2 / Lightsail box,
            any GCP / Azure / Hetzner / DO / Linode VM, a Raspberry Pi at home, or
            a long-running container on Fly / Render. The host needs docker for
            the <code>--driver docker</code> isolation; the{' '}
            <code>--driver process</code> alternative skips that (faster, no
            sandbox isolation — only for trusted setups).
          </p>
          <p>
            <strong>Multi-org</strong> (#774): a single agent process can serve
            multiple orgs by repeating <code>--token</code>. Useful if you want
            one homelab box to back several orgs you administer.
          </p>
          <p>
            Full reference:{' '}
            <Link
              href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/34-runner-agent.md"
              className="text-accent underline-offset-[3px] hover:underline"
            >
              34-runner-agent.md
            </Link>{' '}
            (network posture, troubleshooting, systemd unit).
          </p>
        </div>
      </details>

      <details
        open={selectedKind === 'fargate_byo'}
        className="text-xs text-zinc-500"
      >
        <summary className="cursor-pointer">
          Fargate-BYO configuration (required for the <code>fargate_byo</code> kind)
        </summary>
        <div className="mt-2 space-y-2">
          <label className="block">
            <span>AWS role ARN</span>
            <input
              name="awsRoleArn"
              defaultValue={profile.awsRoleArn ?? ''}
              placeholder="arn:aws:iam::123456789012:role/mergecrew-runner"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>AWS region</span>
            <input
              name="awsRegion"
              defaultValue={profile.awsRegion ?? ''}
              placeholder="us-east-1"
              className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>Fargate cluster</span>
            <input
              name="fargateCluster"
              defaultValue={profile.fargateCluster ?? ''}
              className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>Task definition ARN</span>
            <input
              name="fargateTaskDefinition"
              defaultValue={profile.fargateTaskDefinition ?? ''}
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>Subnets (comma-separated)</span>
            <input
              name="fargateSubnets"
              defaultValue={(profile.fargateSubnets ?? []).join(', ')}
              placeholder="subnet-aaa, subnet-bbb"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>Security groups (comma-separated, optional)</span>
            <input
              name="fargateSecurityGroups"
              defaultValue={(profile.fargateSecurityGroups ?? []).join(', ')}
              placeholder="sg-aaa"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          {profile.awsExternalId && (
            <div className="space-y-1">
              <p>
                External ID:{' '}
                <code className="font-mono text-ink">{profile.awsExternalId}</code>{' '}
                — paste this into your role&apos;s trust policy. Generated once per
                org and never rotated.
              </p>
              <details>
                <summary className="cursor-pointer">Trust policy snippet</summary>
                <pre className="mt-2 overflow-auto rounded bg-zinc-50 p-3 text-[11px] dark:bg-zinc-900">
                  {trustPolicySnippet}
                </pre>
                <p className="mt-1">
                  Replace <code>&lt;deployment-aws-account-id&gt;</code> with the
                  operator&apos;s AWS account ID. See{' '}
                  <Link
                    href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/35-runner-fargate-byo.md"
                    className="text-accent underline-offset-[3px] hover:underline"
                  >
                    35-runner-fargate-byo.md
                  </Link>{' '}
                  for the IAM least-privilege list.
                </p>
              </details>
            </div>
          )}
          <p className="text-zinc-500">
            Dispatch flow: supervisor mints a per-step agent token, performs{' '}
            <code>sts:AssumeRole</code> with the external ID above, and launches an
            ECS task running <code>mergecrew/runner-agent</code> with the token in env.
            No long-lived AWS keys are stored on the deployment.
          </p>
        </div>
      </details>

      <details
        open={selectedKind === 'github_actions'}
        className="text-xs text-zinc-500"
      >
        <summary className="cursor-pointer">
          GitHub Actions configuration (required for the <code>github_actions</code> kind)
        </summary>
        <div className="mt-2 space-y-2">
          <label className="block">
            <span>Repo (owner/repo)</span>
            <input
              name="githubRepoFullName"
              defaultValue={profile.githubRepoFullName ?? ''}
              placeholder="acme/my-repo"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>Workflow file</span>
            <input
              name="githubWorkflowFileName"
              defaultValue={profile.githubWorkflowFileName ?? ''}
              placeholder="mergecrew-runner.yml"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <label className="block">
            <span>
              GitHub PAT
              {profile.githubTokenConfigured ? (
                <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  configured
                </span>
              ) : null}
            </span>
            <input
              type="password"
              name="githubPat"
              placeholder={
                profile.githubTokenConfigured
                  ? 'leave blank to keep the existing token'
                  : 'ghp_… (repo + workflow scopes)'
              }
              autoComplete="off"
              className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            />
          </label>
          <p className="text-zinc-500">
            Dispatch flow: supervisor mints a per-step agent token, calls{' '}
            <code>workflow_dispatch</code> on the repo with{' '}
            <code>mergecrewStepId</code>, <code>mergecrewAgentToken</code>, and{' '}
            <code>mergecrewApiUrl</code> as inputs. The workflow runs{' '}
            <code>mergecrew/runner-agent</code> with those inputs as env. See{' '}
            <Link
              href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/36-runner-github-actions.md"
              className="text-accent underline-offset-[3px] hover:underline"
            >
              36-runner-github-actions.md
            </Link>{' '}
            for the example workflow YAML.
          </p>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit">
          Save
        </Button>
        {selectedKind === 'agent' && (
          <Link
            href={`/orgs/${slug}/settings/runner-agents`}
            className="text-sm font-medium text-accent underline-offset-[3px] hover:underline"
          >
            Continue → Agent tokens
          </Link>
        )}
      </div>
    </div>
  );
}
