'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function acceptInvitation(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) redirect('/account/invitations?error=1');
  const session = await requireSession();
  let slug: string | null = null;
  try {
    const r = await api<{ organization: { slug: string } }>(`/v1/me/invitations/${id}/accept`, {
      method: 'POST',
      session,
    });
    slug = r.organization.slug;
  } catch {
    slug = null;
  }
  if (!slug) redirect('/account/invitations?error=1');
  revalidatePath('/account/invitations');
  redirect(`/orgs/${encodeURIComponent(slug)}`);
}

export async function declineInvitation(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) redirect('/account/invitations?error=1');
  const session = await requireSession();
  try {
    await api(`/v1/me/invitations/${id}/decline`, { method: 'POST', session });
  } catch {
    /* already gone */
  }
  revalidatePath('/account/invitations');
  redirect('/account/invitations');
}
