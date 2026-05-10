import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { MfaRequiredCallout, isMfaGateError } from '@/components/mfa-required-callout';

async function createAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('orgSlug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const projectSlug = String(formData.get('slug') ?? '').trim();
  if (!name || !projectSlug) return;
  const session = await requireSession();
  try {
    await api(`/v1/orgs/${slug}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name, slug: projectSlug }),
      session,
    });
  } catch (err) {
    // Admin/owner write actions go through the RoleGuard MFA gate.
    // Bounce to /account/security so the user can enroll instead of
    // crashing the page with a raw 403.
    if (isMfaGateError(err)) {
      redirect(
        '/account/security?return_to=' +
          encodeURIComponent(`/orgs/${slug}/projects/new`),
      );
    }
    throw err;
  }
  redirect(`/orgs/${slug}/projects/${projectSlug}`);
}

export default async function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const canEdit = await hasRole(slug, session, 'admin');

  // Pre-check MFA so an unenrolled admin lands on a clear CTA instead of
  // submitting the form, hitting the RoleGuard MFA gate, and crashing the
  // page. Same pattern as /settings/api-keys and /settings/webhooks.
  let mfaBlocked = false;
  if (canEdit) {
    const mfa = await api<{ enrolled: boolean }>('/v1/me/mfa', { session }).catch(
      () => ({ enrolled: false }),
    );
    if (!mfa.enrolled) mfaBlocked = true;
  }

  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <h1 className="text-xl font-semibold">Create a project</h1>

      {mfaBlocked && <MfaRequiredCallout />}

      <Card>
        <form action={createAction} className="space-y-3">
          <input type="hidden" name="orgSlug" value={slug} />
          <label className="block text-sm">
            <span className="text-zinc-500">Project name</span>
            <input
              name="name"
              required
              disabled={mfaBlocked}
              className="mt-1 block w-full rounded border px-3 py-2 bg-transparent disabled:opacity-50"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-500">Slug</span>
            <input
              name="slug"
              required
              disabled={mfaBlocked}
              className="mt-1 block w-full rounded border px-3 py-2 bg-transparent font-mono disabled:opacity-50"
            />
          </label>
          <div className="flex justify-end">
            <Button variant="primary" disabled={mfaBlocked}>
              Create
            </Button>
          </div>
        </form>
      </Card>
      <p className="text-sm text-zinc-500">
        Once the project exists, connect a GitHub repo and an issue tracker from the project's
        Settings → Integrations page.
      </p>
    </main>
  );
}
