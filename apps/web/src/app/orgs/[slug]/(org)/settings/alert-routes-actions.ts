'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export type AlertEventKind =
  | 'digest.daily'
  | 'run.failed'
  | 'slo.breaching'
  | 'slo.recovered';

export type AlertChannel = 'slack' | 'email-user';

export interface AlertRoutesResponse {
  items: Array<{
    eventKind: AlertEventKind;
    channels: AlertChannel[];
    isDefault: boolean;
  }>;
}

export type AlertRoute = AlertRoutesResponse['items'][number];

export async function setAlertRouteAction(
  slug: string,
  eventKind: AlertEventKind,
  channels: AlertChannel[],
): Promise<AlertRoute> {
  const session = await requireSession();
  const r = await api<AlertRoute>(
    `/v1/orgs/${slug}/notifications/routes/${eventKind}`,
    {
      method: 'PUT',
      body: JSON.stringify({ channels }),
      session,
    },
  );
  revalidatePath(`/orgs/${slug}/settings`);
  return r;
}
