import Link from 'next/link';
import { getSession } from '@/lib/session';
import { api } from '@/lib/api';
import { LinkButton } from '@/components/ui';

export default async function RootPage() {
  const session = await getSession();
  if (!session) {
    return (
      <main className="mx-auto max-w-2xl p-12 text-center">
        <h1 className="text-3xl font-semibold">Mergecrew</h1>
        <p className="mt-2 text-zinc-500">Autonomous product team in a box.</p>
        <div className="mt-6"><LinkButton href="/login" variant="primary">Sign in</LinkButton></div>
      </main>
    );
  }
  let orgs: { items: Array<{ slug: string; name: string }> } = { items: [] };
  try {
    orgs = await api<{ items: Array<{ slug: string; name: string }> }>('/v1/orgs', { session });
  } catch {
    orgs = { items: [] };
  }

  if (orgs.items.length === 0) {
    return (
      <main className="mx-auto max-w-2xl p-12">
        <h1 className="text-2xl font-semibold">Welcome to Mergecrew</h1>
        <p className="mt-2 text-zinc-500">Create your first organization to begin.</p>
        <div className="mt-6"><LinkButton href="/orgs/new" variant="primary">Create organization</LinkButton></div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold mb-4">Your organizations</h1>
      <ul className="space-y-2">
        {orgs.items.map((o) => (
          <li key={o.slug}>
            <Link className="block rounded border px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900" href={`/orgs/${o.slug}`}>
              <div className="font-medium">{o.name}</div>
              <div className="text-sm text-zinc-500">/{o.slug}</div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
