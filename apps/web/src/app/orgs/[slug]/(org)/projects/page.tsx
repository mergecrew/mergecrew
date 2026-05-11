import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton } from '@/components/ui';
import { FirstRunEmptyState } from '@/components/first-run-empty-state';

export default async function ProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const projects = await api<{ items: any[] }>(`/v1/orgs/${slug}/projects`, { session });

  if (projects.items.length === 0) {
    return (
      <main className="mx-auto max-w-3xl p-6 space-y-4">
        <h1 className="text-xl font-semibold">Projects</h1>
        <FirstRunEmptyState orgSlug={slug} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <LinkButton href={`/orgs/${slug}/projects/new`} variant="primary">New project</LinkButton>
      </div>
      <ul className="space-y-2">
        {projects.items.map((p: any) => (
          <li key={p.id}>
            <Link href={`/orgs/${slug}/projects/${p.slug}`}>
              <Card className="hover:border-accent">
                <div className="font-medium">{p.name}</div>
                <div className="text-sm text-zinc-500">/{p.slug}</div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
