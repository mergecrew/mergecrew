import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton, StatusDot } from '@/components/ui';
import Link from 'next/link';

export default async function TimelinePage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const runs = await api<{ items: any[] }>(`/v1/orgs/${slug}/projects/${projectSlug}/runs?limit=1`, { session });
  const latest = runs.items[0];
  if (!latest) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Timeline</h1>
        <Card className="mt-4"><p className="text-zinc-500">No run today. Schedule one or run now.</p></Card>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Timeline</h1>
          <p className="text-sm text-zinc-500">Run {latest.id.slice(0, 8)}…</p>
        </div>
        <Link href={`/orgs/${slug}/projects/${projectSlug}/runs/${latest.id}`}>
          <LinkButton href={`/orgs/${slug}/projects/${projectSlug}/runs/${latest.id}`}>Open run</LinkButton>
        </Link>
      </header>
      <Card>
        <div className="flex items-center gap-2"><StatusDot status="running" /><span>Subscribe via SSE</span></div>
        <p className="mt-2 text-sm text-zinc-500">
          Live timeline streams from <code className="font-mono">/v1/orgs/{slug}/projects/{projectSlug}/runs/{latest.id}/timeline/stream</code>.
          The replay view lives on the run detail page.
        </p>
      </Card>
    </main>
  );
}
