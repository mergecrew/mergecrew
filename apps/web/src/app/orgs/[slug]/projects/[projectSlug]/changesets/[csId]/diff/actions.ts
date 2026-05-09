'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

interface CreateInput {
  filePath: string;
  lineRange?: { startLine: number; endLine: number };
  body: string;
  parentId?: string;
}

function pathFor(slug: string, projectSlug: string, csId: string): string {
  return `/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/diff`;
}

export async function createCommentAction(
  slug: string,
  projectSlug: string,
  csId: string,
  input: CreateInput,
): Promise<{ ok: true; comment: any } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const c = await api<any>(
      `/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/comments`,
      { method: 'POST', body: JSON.stringify(input), session },
    );
    revalidatePath(pathFor(slug, projectSlug, csId));
    return { ok: true, comment: c };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function updateCommentAction(
  slug: string,
  projectSlug: string,
  csId: string,
  commentId: string,
  patch: { body?: string; resolved?: boolean },
): Promise<{ ok: true; comment: any } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const c = await api<any>(
      `/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/comments/${commentId}`,
      { method: 'PATCH', body: JSON.stringify(patch), session },
    );
    revalidatePath(pathFor(slug, projectSlug, csId));
    return { ok: true, comment: c };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function deleteCommentAction(
  slug: string,
  projectSlug: string,
  csId: string,
  commentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    await api(
      `/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/comments/${commentId}`,
      { method: 'DELETE', session },
    );
    revalidatePath(pathFor(slug, projectSlug, csId));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
