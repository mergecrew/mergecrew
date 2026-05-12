'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function rollbackChangesetAction(slug: string, projectSlug: string, csId: string) {
  const session = await requireSession();
  const r = await api<{
    ok: true;
    revertPrNumber: number;
    revertPrUrl: string;
    migrationsWarning: boolean;
    migrationFiles: string[];
  }>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/rollback`, {
    method: 'POST',
    session,
  });
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`);
  return r;
}
