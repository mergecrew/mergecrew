'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function cancelRunAction(
  slug: string,
  projectSlug: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    await api(`/v1/orgs/${slug}/projects/${projectSlug}/runs/${runId}/cancel`, {
      method: 'POST',
      session,
    });
    revalidatePath(`/orgs/${slug}/projects/${projectSlug}/runs/${runId}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
