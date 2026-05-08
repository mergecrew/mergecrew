import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';

export default async function CostsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const costs = await api<{ items: any[]; days: number }>(`/v1/orgs/${slug}/costs?days=30`, { session });

  const total = costs.items.reduce((s, r) => s + Number(r.usd ?? 0), 0);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Costs</h1>
        <p className="text-sm text-zinc-500">Last {costs.days} days · ${total.toFixed(2)} total</p>
      </header>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="pb-2">Day</th>
              <th className="pb-2">Provider</th>
              <th className="pb-2">Model</th>
              <th className="pb-2 text-right">Tokens</th>
              <th className="pb-2 text-right">USD</th>
            </tr>
          </thead>
          <tbody>
            {costs.items.map((r: any, i: number) => (
              <tr key={i} className="border-t">
                <td className="py-1">{new Date(r.day).toLocaleDateString()}</td>
                <td className="py-1">{r.provider_kind}</td>
                <td className="py-1 font-mono text-xs">{r.model_id}</td>
                <td className="py-1 text-right">{r.tokens.toLocaleString()}</td>
                <td className="py-1 text-right">${Number(r.usd).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
