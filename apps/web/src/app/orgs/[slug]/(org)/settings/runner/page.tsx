import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';

type ProfileKind =
  | 'none'
  | 'instance_builtin'
  | 'agent'
  | 'fargate_byo'
  | 'github_actions';

interface AgentSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  agentVersion: string | null;
}

interface ProfileResponse {
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
  agents: AgentSummary[];
}

const KIND_LABEL: Record<ProfileKind, string> = {
  none: 'None',
  instance_builtin: 'Instance built-in',
  agent: 'BYO agent',
  fargate_byo: 'AWS Fargate (your account)',
  github_actions: 'GitHub Actions',
};

const KIND_DESC: Record<ProfileKind, string> = {
  none: 'Runs are blocked until you pick a runner profile.',
  instance_builtin:
    'Use the deployment\'s built-in runner. Available only to orgs the operator has trusted (MERGECREW_TRUSTED_ORG_SLUGS).',
  agent:
    'Run the `mergecrew/runner-agent` container on your own machine or cloud account. The agent pulls jobs over HTTPS and executes them locally.',
  fargate_byo:
    'Execute steps as ECS tasks in your own AWS account via STS role assumption. No long-lived AWS keys are stored.',
  github_actions:
    'Dispatch steps to a workflow_dispatch trigger in a repo you own. The agent runs inside a GitHub-hosted runner; you pay for nothing on the deployment side.',
};

function parseCsvList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function updateProfileAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const kind = String(formData.get('kind') ?? '') as ProfileKind;
  if (!kind) return;
  const body: Record<string, unknown> = { kind };
  for (const field of [
    'awsRoleArn',
    'awsRegion',
    'fargateCluster',
    'fargateTaskDefinition',
    'githubRepoFullName',
    'githubWorkflowFileName',
    'githubPat',
  ]) {
    const v = String(formData.get(field) ?? '').trim();
    if (v) body[field] = v;
  }
  const subnetsRaw = String(formData.get('fargateSubnets') ?? '').trim();
  if (subnetsRaw) body['fargateSubnets'] = parseCsvList(subnetsRaw);
  const sgRaw = String(formData.get('fargateSecurityGroups') ?? '').trim();
  if (sgRaw) body['fargateSecurityGroups'] = parseCsvList(sgRaw);
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/runner-profile`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings/runner`);
}

async function updateConcurrencyCapAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const raw = String(formData.get('orgConcurrencyCap') ?? '').trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/concurrency-cap`, {
    method: 'PATCH',
    body: JSON.stringify({ orgConcurrencyCap: Math.floor(parsed) }),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings/runner`);
}

function trustPolicySnippet(externalId: string, deploymentAccountId = '<deployment-aws-account-id>'): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${deploymentAccountId}:root` },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'sts:ExternalId': externalId } },
        },
      ],
    },
    null,
    2,
  );
}

function relativeLastSeen(iso: string | null): string {
  if (!iso) return 'never';
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function badgeFor(lastSeenAt: string | null, revoked: boolean) {
  if (revoked) return { color: 'red' as const, label: 'revoked' };
  if (!lastSeenAt) return { color: 'grey' as const, label: 'never seen' };
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 60_000) return { color: 'green' as const, label: 'online' };
  if (ageMs < 5 * 60_000) return { color: 'amber' as const, label: 'idle' };
  return { color: 'grey' as const, label: 'offline' };
}

function StatusBadge({ color, label }: { color: 'green' | 'amber' | 'grey' | 'red'; label: string }) {
  const cls = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    grey: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  }[color];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${cls}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          color === 'green' ? 'bg-green-500' :
          color === 'amber' ? 'bg-amber-500' :
          color === 'red' ? 'bg-red-500' : 'bg-zinc-400'
        }`}
      />
      {label}
    </span>
  );
}

export default async function RunnerProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const canEdit = await hasRole(slug, session, 'admin');

  const [profile, concurrency] = await Promise.all([
    api<ProfileResponse>(`/v1/orgs/${slug}/runner-profile`, { session }),
    api<{ orgConcurrencyCap: number }>(`/v1/orgs/${slug}/concurrency-cap`, { session }),
  ]);
  const allKinds: ProfileKind[] = [
    'none',
    'instance_builtin',
    'agent',
    'fargate_byo',
    'github_actions',
  ];

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Runner</h1>
        <p className="text-sm text-zinc-500">
          Which execution substrate runs this org&apos;s steps. Required for{' '}
          <Link href={`/orgs/${slug}`} className="text-accent underline-offset-[3px] hover:underline">
            any run
          </Link>{' '}
          to start.
        </p>
      </header>

      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-medium">Current profile</h2>
          <span className="text-xs text-zinc-500">
            {profile.isTrustedForInstanceBuiltin
              ? 'Trusted for instance-builtin'
              : 'Not trusted for instance-builtin'}
          </span>
        </div>
        <p className="mt-2 text-sm">
          <strong>{KIND_LABEL[profile.kind]}</strong> — {KIND_DESC[profile.kind]}
        </p>
      </Card>

      <Card>
        <h2 className="font-medium">Concurrency cap</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Max concurrent agent steps the orchestrator will dispatch for this org.
          Enforced upstream of every queue (instance, agent, fargate-byo) — the{' '}
          <code>(N+1)</code>-th step is deferred rather than queued. Set to{' '}
          <code>0</code> for unlimited.
        </p>
        {canEdit ? (
          <form action={updateConcurrencyCapAction} className="mt-3 flex items-center gap-2 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <input
              type="number"
              name="orgConcurrencyCap"
              min={0}
              max={100}
              defaultValue={concurrency.orgConcurrencyCap}
              className="w-20 rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            />
            <Button variant="primary" type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : (
          <p className="mt-2 text-sm">
            <strong>{concurrency.orgConcurrencyCap}</strong>
            {concurrency.orgConcurrencyCap === 0 ? ' (unlimited)' : null}
          </p>
        )}
      </Card>

      {canEdit && (
        <Card>
          <h2 className="font-medium">Change profile</h2>
          <form action={updateProfileAction} className="mt-3 space-y-3 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <div className="space-y-2">
              {allKinds.map((k) => {
                const disabled =
                  k === 'instance_builtin' && !profile.isTrustedForInstanceBuiltin;
                return (
                  <label
                    key={k}
                    className={`flex items-start gap-3 rounded border p-3 ${
                      disabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer hover:border-accent'
                    } ${profile.kind === k ? 'border-accent' : 'border-zinc-200 dark:border-zinc-700'}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={k}
                      defaultChecked={profile.kind === k}
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
            <details open={profile.kind === 'agent'} className="text-xs text-zinc-500">
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
                      Settings → Runner agents
                    </Link>
                    , click <strong>Enrol agent</strong>, give it a host-recognisable
                    name (e.g. <code>ec2-runner-1</code>), and copy the token. It looks
                    like <code className="font-mono">mca_{slug}_…</code> and is shown{' '}
                    <strong>exactly once</strong>.
                  </li>
                  <li>
                    On the host (your EC2 box, your GHA VM, whatever has docker), run:
                    <pre className="mt-2 overflow-auto rounded bg-zinc-50 p-3 text-[11px] text-ink dark:bg-zinc-900 dark:text-zinc-200">
{`docker run -d --restart unless-stopped \\
  --name mergecrew-agent \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  ghcr.io/mergecrew/runner-agent:latest \\
    --token mca_${slug}_<paste-from-step-2> \\
    --api-url ${process.env.MERGECREW_API_BASE_URL ?? process.env.API_BASE_URL ?? '<your-mergecrew-host>'} \\
    --name ec2-runner-1 \\
    --driver docker \\
    --concurrency 2`}
                    </pre>
                  </li>
                  <li>
                    Within ~30 seconds the agent shows up under <strong>Enrolled agents</strong>{' '}
                    below with an <em>online</em> badge. New runs for this org will dispatch to it.
                  </li>
                </ol>
                <p>
                  <strong>Where can it run?</strong> Anywhere reachable by outbound HTTPS to{' '}
                  this deployment&apos;s API. Concretely: any AWS EC2 / Lightsail box, any GCP / Azure /
                  Hetzner / DO / Linode VM, a Raspberry Pi at home, or a long-running container
                  on Fly / Render. The host needs docker for the <code>--driver docker</code>{' '}
                  isolation; the <code>--driver process</code> alternative skips that (faster,
                  no sandbox isolation — only for trusted setups).
                </p>
                <p>
                  <strong>Multi-org</strong> (#774): a single agent process can serve multiple orgs
                  by repeating <code>--token</code>. Useful if you want one homelab box to back
                  several orgs you administer.
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
            <details open={profile.kind === 'fargate_byo'} className="text-xs text-zinc-500">
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
                        {trustPolicySnippet(profile.awsExternalId)}
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
            <details open={profile.kind === 'github_actions'} className="text-xs text-zinc-500">
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
            <Button variant="primary" type="submit">
              Save
            </Button>
          </form>
        </Card>
      )}

      {profile.kind === 'agent' && (
        <Card>
          <h2 className="font-medium">Enrolled agents</h2>
          {profile.agents.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No agents enrolled yet. Go to{' '}
              <Link
                href={`/orgs/${slug}/settings/runner-agents`}
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Settings → Runner agents
              </Link>{' '}
              to enrol one.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              {profile.agents.map((a) => {
                const b = badgeFor(a.lastSeenAt, Boolean(a.revokedAt));
                return (
                  <li key={a.id} className="flex items-baseline justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-zinc-500">
                        <code className="font-mono">{a.prefix}…</code>
                        <span className="ml-2">last seen {relativeLastSeen(a.lastSeenAt)}</span>
                        {a.agentVersion && (
                          <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                            v{a.agentVersion}
                          </span>
                        )}
                      </div>
                    </div>
                    <StatusBadge color={b.color} label={b.label} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </main>
  );
}
