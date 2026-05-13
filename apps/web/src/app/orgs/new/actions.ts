'use server';

import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

/**
 * Create-org server action shared by the first-time landing on `/`
 * (zero-orgs branch) and the user-menu-driven `/orgs/new` page. Both
 * routes need the same POST + redirect path; keeping a single action
 * means the redesign at `/` and the lighter `/orgs/new` page can pass
 * the same `action` prop into the shared `<CreateOrgForm>` client
 * component without each page hand-rolling its own.
 */
export async function createOrgAction(formData: FormData): Promise<void> {
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
