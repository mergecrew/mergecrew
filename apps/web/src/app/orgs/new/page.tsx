import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button } from '@/components/ui';

async function createAction(formData: FormData) {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  if (!name || !slug) return;
  const session = await requireSession();
  await api(`/v1/orgs`, {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
    session,
  });
  redirect(`/orgs/${slug}`);
}

export default function NewOrgPage() {
  return (
    <main className="mx-auto max-w-md p-12 space-y-4">
      <h1 className="text-xl font-semibold">Create an organization</h1>
      <Card>
        <form action={createAction} className="space-y-3">
          <label className="block text-sm">
            <span className="text-zinc-500">Org name</span>
            <input name="name" required className="mt-1 block w-full rounded border px-3 py-2 bg-transparent" />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-500">Slug</span>
            <input name="slug" required className="mt-1 block w-full rounded border px-3 py-2 bg-transparent font-mono" />
          </label>
          <div className="flex justify-end"><Button variant="primary">Create</Button></div>
        </form>
      </Card>
    </main>
  );
}
