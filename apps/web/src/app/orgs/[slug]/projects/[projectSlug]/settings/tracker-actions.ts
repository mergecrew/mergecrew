'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function upsertTrackerAction(
  slug: string,
  projectSlug: string,
  input: { adapterId: string; config: Record<string, unknown>; token?: string },
) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/tracker`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}

export async function deleteTrackerAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/tracker`, {
    method: 'DELETE',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
}

export async function testTrackerAction(slug: string, projectSlug: string) {
  const session = await requireSession();
  return api<{ ok: boolean; sample?: unknown; error?: string }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/tracker/test`,
    { method: 'POST', session },
  );
}
