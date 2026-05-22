'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

export type SloMetric = 'stepPassRate' | 'runFailureRate' | 'p95StepMs' | 'dailyCostUsd';

export interface SloListResponse {
  items: Array<{
    id: string;
    name: string;
    metric: SloMetric;
    comparator: 'gte' | 'lte';
    threshold: number;
    windowHours: number;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    currentState: 'OK' | 'AT_RISK' | 'BREACHING' | 'INSUFFICIENT_DATA' | 'DISABLED';
    currentValue: number | null;
  }>;
}

export type SloRow = SloListResponse['items'][number];

function revalidate(slug: string, projectSlug: string): void {
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/settings`);
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}`);
  revalidatePath(`/orgs/${slug}/projects/${projectSlug}/metrics`);
}

export async function createSloAction(
  slug: string,
  projectSlug: string,
  input: {
    name: string;
    metric: SloMetric;
    comparator: 'gte' | 'lte';
    threshold: number;
    windowHours: number;
    enabled?: boolean;
  },
): Promise<SloRow> {
  const session = await requireSession();
  const row = await api<Omit<SloRow, 'currentState' | 'currentValue'>>(
    `/v1/orgs/${slug}/projects/${projectSlug}/slos`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      session,
    },
  );
  revalidate(slug, projectSlug);
  return {
    ...row,
    currentState: 'INSUFFICIENT_DATA',
    currentValue: null,
  };
}

export async function updateSloAction(
  slug: string,
  projectSlug: string,
  sloId: string,
  patch: Partial<{
    name: string;
    metric: SloMetric;
    comparator: 'gte' | 'lte';
    threshold: number;
    windowHours: number;
    enabled: boolean;
  }>,
): Promise<SloRow> {
  const session = await requireSession();
  const row = await api<Omit<SloRow, 'currentState' | 'currentValue'>>(
    `/v1/orgs/${slug}/projects/${projectSlug}/slos/${sloId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
      session,
    },
  );
  revalidate(slug, projectSlug);
  // Caller will get current state from the next list refresh; until
  // then keep the prior state by treating server response as canonical
  // baseline.
  return {
    ...row,
    currentState: row.enabled ? 'INSUFFICIENT_DATA' : 'DISABLED',
    currentValue: null,
  };
}

export async function deleteSloAction(
  slug: string,
  projectSlug: string,
  sloId: string,
): Promise<void> {
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/slos/${sloId}`, {
    method: 'DELETE',
    session,
  });
  revalidate(slug, projectSlug);
}
