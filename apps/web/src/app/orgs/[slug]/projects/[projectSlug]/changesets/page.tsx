import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip } from '@/components/ui';

export default async function ChangesetsPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const list = await api<{ items: any[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/changesets`,
    { session },
  );

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-3">
      <h1 className="text-xl font-semibold">Changesets</h1>
      <ul className="space-y-2">
        {list.items.map((cs: any) => (
          <li key={cs.id}>
            <Link href={`/orgs/${slug}/projects/${projectSlug}/changesets/${cs.id}`}>
              <Card className="hover:border-accent">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{cs.title}</div>
                  <Chip>{cs.status}</Chip>
                </div>
                <div className="mt-1 text-xs font-mono text-zinc-500">{cs.id}</div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
