import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';

export default async function ActivityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const events = await api<{ items: any[] }>(`/v1/orgs/${slug}/activity?limit=200`, { session });

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold mb-3">Activity</h1>
      <Card>
        <ol className="space-y-1 text-sm">
          {events.items.map((e: any) => (
            <li key={e.id} className="flex gap-3">
              <span className="font-mono text-zinc-400 w-32 shrink-0">{new Date(e.occurredAt).toLocaleString()}</span>
              <span className="font-mono text-xs text-zinc-500 w-44 shrink-0">{e.type}</span>
              <span className="text-zinc-700 dark:text-zinc-200">{summary(e)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </main>
  );
}

function summary(e: any): string {
  const p = e.payload ?? {};
  if (e.type === 'AGENT_TOOL_CALL') return `${p.name}${p.brief ? ' — ' + p.brief : ''}`;
  if (e.type === 'CHANGESET_PROMOTED') return `promoted ${p.changesetId}`;
  if (e.type === 'CHANGESET_AUTO_PROMOTED') return `auto-promoted via "${p.ruleName}" (PR #${p.prNumber})`;
  if (e.type === 'WORKFLOW_STARTED') return `workflow ${p.workflowId}`;
  return JSON.stringify(p).slice(0, 200);
}
