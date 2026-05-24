import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { CreatedSecretCallout } from '@/components/created-secret-callout';

interface RunnerAgentSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  agentVersion: string | null;
}

interface IssuedRunnerAgent {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  token: string;
}

async function issueAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const session = await requireSession();
  const issued = await api<IssuedRunnerAgent>(`/v1/orgs/${slug}/runner-agents`, {
    method: 'POST',
    body: JSON.stringify({ name }),
    session,
  });
  // One-time-display: stash the plaintext token in a short-lived cookie
  // scoped to this page so the next render shows it once and never again.
  const { cookies } = await import('next/headers');
  (await cookies()).set(`mc-runner-agent-token-${issued.id}`, issued.token, {
    maxAge: 60,
    path: `/orgs/${slug}/settings/runner-agents`,
    httpOnly: true,
  });
  revalidatePath(`/orgs/${slug}/settings/runner-agents`);
}

async function revokeAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/runner-agents/${id}`, { method: 'DELETE', session });
  revalidatePath(`/orgs/${slug}/settings/runner-agents`);
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

export default async function RunnerAgentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const canEdit = await hasRole(slug, session, 'admin');

  const list = await api<{ items: RunnerAgentSummary[] }>(
    `/v1/orgs/${slug}/runner-agents`,
    { session },
  );

  const { cookies } = await import('next/headers');
  const ck = await cookies();
  const justIssued = list.items
    .map((a) => ({ a, token: ck.get(`mc-runner-agent-token-${a.id}`)?.value }))
    .find((x) => x.token);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Runner agents</h1>
        <p className="text-sm text-zinc-500">
          Enrol the <code>mergecrew/runner-agent</code> container to execute this org&apos;s steps
          on your own machine or cloud account. Tokens look like{' '}
          <code>mca_{slug}_…</code> and are shown <strong>exactly once</strong> at creation.
        </p>
      </header>

      {justIssued && (
        <CreatedSecretCallout
          secret={justIssued.token!}
          label={`Runner-agent token for "${justIssued.a.name}"`}
        />
      )}

      {canEdit && (
        <Card>
          <h2 className="font-medium">Enrol agent</h2>
          <form action={issueAction} className="mt-3 space-y-2 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">Name</span>
              <input
                name="name"
                required
                placeholder="homelab-1"
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <Button variant="primary" type="submit">
              Issue token
            </Button>
            <p className="mt-2 text-xs text-zinc-500">
              After issuing, you&apos;ll see a one-time setup command. Run it on the machine that
              will host the agent.
            </p>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="font-medium">Active agents</h2>
        {list.items.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No agents enrolled yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {list.items.map((a) => (
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
                    {a.revokedAt && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        revoked
                      </span>
                    )}
                  </div>
                </div>
                {canEdit && !a.revokedAt && (
                  <form action={revokeAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="id" value={a.id} />
                    <Button variant="destructive" type="submit">
                      Revoke
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
