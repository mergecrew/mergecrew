import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button } from '@/components/ui';

async function createAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const projectSlug = String(formData.get('slug') ?? '').trim();
  if (!name || !projectSlug) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, slug: projectSlug }),
    session,
  });
  redirect(`/orgs/${slug}/projects/${projectSlug}`);
}

export default async function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <h1 className="text-xl font-semibold">Create a project</h1>
      <Card>
        <form action={createAction} className="space-y-3">
          <input type="hidden" name="orgSlug" value={slug} />
          <label className="block text-sm">
            <span className="text-zinc-500">Project name</span>
            <input name="name" required className="mt-1 block w-full rounded border px-3 py-2 bg-transparent" />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-500">Slug</span>
            <input name="slug" required className="mt-1 block w-full rounded border px-3 py-2 bg-transparent font-mono" />
          </label>
          <div className="flex justify-end">
            <Button variant="primary">Create</Button>
          </div>
        </form>
      </Card>
      <div className="space-y-2 text-sm text-zinc-500">
        <p>
          New projects start <span className="font-medium text-amber-700 dark:text-amber-400">paused</span> —
          no scheduled or on-demand runs fire until you finish setup. You can poke
          around the dashboard, lifecycle, and agent roster right away.
        </p>
        <p>
          To turn runs on, connect a GitHub repository and add a dev deploy target
          from <span className="font-mono text-zinc-600 dark:text-zinc-300">Settings → Integrations</span>.
          The project overview will walk you there.
        </p>
        <p>
          Without a dev deploy target the agents can still write code and open PRs,
          but they can't ship a preview URL — digests will say{' '}
          <em>"ready for review"</em> instead of <em>"deployed to dev"</em>. You can
          plug one in later from the same settings page.
        </p>
      </div>
    </main>
  );
}
