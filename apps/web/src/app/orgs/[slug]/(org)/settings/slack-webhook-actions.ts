'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export interface SlackStatus {
  configured: boolean;
  createdAt: string | null;
}

function revalidate(slug: string): void {
  revalidatePath(`/orgs/${slug}/settings`);
}

export async function setSlackWebhookAction(
  slug: string,
  url: string,
): Promise<SlackStatus> {
  const session = await requireSession();
  const r = await api<SlackStatus>(`/v1/orgs/${slug}/notifications/slack`, {
    method: 'PUT',
    body: JSON.stringify({ url }),
    session,
  });
  revalidate(slug);
  return r;
}

export async function clearSlackWebhookAction(slug: string): Promise<SlackStatus> {
  const session = await requireSession();
  const r = await api<SlackStatus>(`/v1/orgs/${slug}/notifications/slack`, {
    method: 'DELETE',
    session,
  });
  revalidate(slug);
  return r;
}

export async function testSlackWebhookAction(slug: string): Promise<void> {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/notifications/slack/test`, {
    method: 'POST',
    session,
  });
}
