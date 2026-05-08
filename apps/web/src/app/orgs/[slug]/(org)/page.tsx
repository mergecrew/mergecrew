import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, StatusDot, LinkButton } from '@/components/ui';

export default async function TodayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const projects = await api<{ items: any[] }>(`/v1/orgs/${slug}/projects`, { session });
  const inbox = await api<{ items: any[] }>(`/v1/orgs/${slug}/inbox`, { session });

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-sm text-zinc-500">{new Date().toDateString()}</span>
      </header>

      {inbox.items.length > 0 && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">{inbox.items.length} pending approval{inbox.items.length === 1 ? '' : 's'}</div>
              <div className="text-sm text-zinc-500">Need your review.</div>
            </div>
            <LinkButton href={`/orgs/${slug}/inbox`} variant="primary">Open inbox</LinkButton>
          </div>
        </Card>
      )}

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500 mb-2">Projects</h2>
        {projects.items.length === 0 ? (
          <Card>
            <p className="text-zinc-500">No projects yet.</p>
            <div className="mt-3"><LinkButton href={`/orgs/${slug}/projects/new`} variant="primary">Connect your first GitHub repo</LinkButton></div>
          </Card>
        ) : (
          <ul className="space-y-2">
            {projects.items.map((p: any) => (
              <li key={p.id}>
                <Link className="block" href={`/orgs/${slug}/projects/${p.slug}`}>
                  <Card className="hover:border-accent transition-colors">
                    <div className="flex items-center gap-3">
                      <StatusDot status="idle" />
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-sm text-zinc-500">/{p.slug}</div>
                      </div>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
