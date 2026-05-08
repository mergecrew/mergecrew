import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton, StatusDot } from '@/components/ui';

export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const project = await api<any>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session });
  const runs = await api<{ items: any[] }>(`/v1/orgs/${slug}/projects/${projectSlug}/runs?limit=10`, { session });

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <header className="flex items-baseline justify-end gap-2">
        <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/digest`}>Today's digest</LinkButton>
        <RunNowForm orgSlug={slug} projectSlug={projectSlug} />
      </header>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500 mb-2">Recent runs</h2>
        <ul className="space-y-2">
          {runs.items.length === 0 && (
            <Card><p className="text-zinc-500">No runs yet.</p></Card>
          )}
          {runs.items.map((r: any) => (
            <li key={r.id}>
              <Link href={`/orgs/${slug}/projects/${projectSlug}/runs/${r.id}`}>
                <Card className="hover:border-accent">
                  <div className="flex items-center gap-3">
                    <StatusDot status={statusToDot(r.status)} />
                    <div className="flex-1">
                      <div className="font-medium">{new Date(r.scheduledAt).toLocaleString()}</div>
                      <div className="text-sm text-zinc-500">{r.status}</div>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Link href={`/orgs/${slug}/projects/${projectSlug}/lifecycle`}>
          <Card className="hover:border-accent">
            <div className="font-medium">Lifecycle</div>
            <div className="text-sm text-zinc-500">View workflow graph</div>
          </Card>
        </Link>
        <Link href={`/orgs/${slug}/projects/${projectSlug}/agents`}>
          <Card className="hover:border-accent">
            <div className="font-medium">Agents</div>
            <div className="text-sm text-zinc-500">Roster &amp; model assignments</div>
          </Card>
        </Link>
        <Link href={`/orgs/${slug}/projects/${projectSlug}/changesets`}>
          <Card className="hover:border-accent">
            <div className="font-medium">Changesets</div>
            <div className="text-sm text-zinc-500">All proposed changes</div>
          </Card>
        </Link>
        <Link href={`/orgs/${slug}/projects/${projectSlug}/settings`}>
          <Card className="hover:border-accent">
            <div className="font-medium">Settings</div>
            <div className="text-sm text-zinc-500">Repo, deploy, secrets, gates</div>
          </Card>
        </Link>
      </section>
    </main>
  );
}

function statusToDot(s: string): 'running' | 'paused' | 'idle' | 'failed' | 'done' {
  if (s === 'running') return 'running';
  if (s === 'paused_rate_limit' || s === 'paused_gate') return 'paused';
  if (s === 'failed') return 'failed';
  if (s === 'done') return 'done';
  return 'idle';
}

async function runNowAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/runs`, { method: 'POST', body: '{}', session });
}

function RunNowForm({ orgSlug, projectSlug }: { orgSlug: string; projectSlug: string }) {
  return (
    <form action={runNowAction}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <button className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg" type="submit">Run now</button>
    </form>
  );
}
