'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export async function setEmailDigestEnabledAction(
  enabled: boolean,
): Promise<void> {
  const session = await requireSession();
  await api('/v1/me/notifications', {
    method: 'PATCH',
    body: JSON.stringify({ emailDigestEnabled: enabled }),
    session,
  });
  revalidatePath('/account');
}
