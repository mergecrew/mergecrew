import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button } from '@/components/ui';

export default async function InboxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const inbox = await api<{ items: any[] }>(`/v1/orgs/${slug}/inbox`, { session });

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-3">
      <h1 className="text-xl font-semibold">Inbox</h1>
      {inbox.items.length === 0 && <Card><p className="text-zinc-500">Nothing pending.</p></Card>}
      <ul className="space-y-2">
        {inbox.items.map((a: any) => (
          <li key={a.id}>
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{a.reason}</div>
                  <pre className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap">{JSON.stringify(a.details, null, 2)}</pre>
                </div>
                <ResolveForm slug={slug} approvalId={a.id} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}

async function resolveAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const approvalId = String(formData.get('approvalId') ?? '');
  const resolution = String(formData.get('resolution') ?? 'approve');
  const session = await requireSession();
  await api(
    `/v1/orgs/${slug}/projects/${projectSlug}/approvals/${approvalId}/resolve`,
    { method: 'POST', body: JSON.stringify({ resolution }), session },
  );
}

function ResolveForm({ slug, approvalId }: { slug: string; approvalId: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(['approve', 'reject'] as const).map((kind) => (
        <form action={resolveAction} key={kind}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="projectSlug" value="-" />
          <input type="hidden" name="approvalId" value={approvalId} />
          <input type="hidden" name="resolution" value={kind} />
          <Button variant={kind === 'approve' ? 'primary' : 'destructive'}>{kind}</Button>
        </form>
      ))}
    </div>
  );
}
