import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { publicBaseUrl } from '@/lib/public-url';
import {
  RunnerKindPicker,
  KIND_LABEL,
  KIND_DESC,
  type ProfileKind,
} from './runner-kind-picker';

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

  const [profile, concurrency, apiUrl] = await Promise.all([
    api<ProfileResponse>(`/v1/orgs/${slug}/runner-profile`, { session }),
    api<{ orgConcurrencyCap: number }>(`/v1/orgs/${slug}/concurrency-cap`, { session }),
    publicBaseUrl(),
  ]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Runner profile</h1>
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
            <RunnerKindPicker
              slug={slug}
              profile={profile}
              publicBaseUrl={apiUrl}
              trustPolicySnippet={trustPolicySnippet(profile.awsExternalId ?? '')}
            />
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
                Settings → Agent tokens
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
