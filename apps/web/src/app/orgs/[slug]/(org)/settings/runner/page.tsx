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
    'Dispatch steps to a workflow_dispatch trigger in a repo you own. Coming in v1.1.',
};

async function updateProfileAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const kind = String(formData.get('kind') ?? '') as ProfileKind;
  if (!kind) return;
  const body: Record<string, unknown> = { kind };
  for (const field of ['awsRoleArn', 'awsRegion', 'fargateCluster', 'fargateTaskDefinition']) {
    const v = String(formData.get(field) ?? '').trim();
    if (v) body[field] = v;
  }
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/runner-profile`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings/runner`);
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

  const profile = await api<ProfileResponse>(`/v1/orgs/${slug}/runner-profile`, { session });
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

      {canEdit && (
        <Card>
          <h2 className="font-medium">Change profile</h2>
          <form action={updateProfileAction} className="mt-3 space-y-3 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <div className="space-y-2">
              {allKinds.map((k) => {
                const disabled =
                  k === 'instance_builtin' && !profile.isTrustedForInstanceBuiltin;
                const isComingSoon = k === 'github_actions';
                return (
                  <label
                    key={k}
                    className={`flex items-start gap-3 rounded border p-3 ${
                      disabled || isComingSoon
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer hover:border-accent'
                    } ${profile.kind === k ? 'border-accent' : 'border-zinc-200 dark:border-zinc-700'}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={k}
                      defaultChecked={profile.kind === k}
                      disabled={disabled || isComingSoon}
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
                        {isComingSoon && (
                          <span className="ml-2 text-xs text-zinc-500">(coming v1.1)</span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">{KIND_DESC[k]}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer">Fargate-BYO advanced fields (optional)</summary>
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
                {profile.awsExternalId && (
                  <p className="text-zinc-500">
                    External ID:{' '}
                    <code className="font-mono text-ink">{profile.awsExternalId}</code> —
                    paste this into your role&apos;s trust policy.
                  </p>
                )}
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
