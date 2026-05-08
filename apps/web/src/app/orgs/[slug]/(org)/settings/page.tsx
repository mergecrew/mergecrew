import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';

export default async function OrgSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const org = await api<any>(`/v1/orgs/${slug}`, { session });
  const members = await api<{ items: any[] }>(`/v1/orgs/${slug}/members`, { session });
  const providers = await api<{ items: any[] }>(`/v1/orgs/${slug}/llm/providers`, { session });

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Org &nbsp;<code>{org.slug}</code></p>
      </header>
      <Card>
        <h2 className="font-medium">Members</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {members.items.map((m: any) => (
            <li key={m.id} className="flex items-baseline justify-between">
              <span>{m.user.email}</span>
              <span className="text-zinc-500">{m.role}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2 className="font-medium">LLM providers</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {providers.items.map((p: any) => (
            <li key={p.id} className="flex items-baseline justify-between">
              <span>{p.label}</span>
              <span className="text-zinc-500">{p.kind}{p.endpoint ? ` · ${p.endpoint}` : ''}</span>
            </li>
          ))}
          {providers.items.length === 0 && (
            <li className="text-zinc-500">None configured. Add one via the API: <code>POST /v1/orgs/{slug}/llm/providers</code></li>
          )}
        </ul>
      </Card>
    </main>
  );
}
