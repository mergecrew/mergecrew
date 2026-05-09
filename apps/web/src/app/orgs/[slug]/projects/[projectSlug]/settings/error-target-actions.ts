'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function upsertErrorTargetAction(
  slug: string,
  projectSlug: string,
  input: { adapterId: string; config: Record<string, unknown>; token?: string },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/error-target`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}

export async function deleteErrorTargetAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/error-target`, {
    method: 'DELETE',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}
