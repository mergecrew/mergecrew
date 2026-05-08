'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import type { LifecycleScope } from './scope';
import { lifecycleBasePath, lifecycleRevalidatePath } from './scope';

async function call<T = unknown>(
  scope: LifecycleScope,
  path: string,
  init: { method: 'PUT' | 'DELETE' | 'POST'; body?: unknown },
): Promise<T> {
  const session = await requireSession();
  const result = await api<T>(`${lifecycleBasePath(scope)}${path}`, {
    method: init.method,
    session,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  revalidatePath(lifecycleRevalidatePath(scope));
  return result;
}

export async function upsertAgentAction(scope: LifecycleScope, ref: string, def: unknown) {
  return call(scope, `/agents/${encodeURIComponent(ref)}`, { method: 'PUT', body: def });
}
export async function deleteAgentAction(scope: LifecycleScope, ref: string) {
  return call(scope, `/agents/${encodeURIComponent(ref)}`, { method: 'DELETE' });
}
export async function upsertWorkflowAction(scope: LifecycleScope, id: string, def: unknown) {
  return call(scope, `/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: def });
}
export async function deleteWorkflowAction(scope: LifecycleScope, id: string) {
  return call(scope, `/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function upsertCustomSkillAction(scope: LifecycleScope, name: string, def: unknown) {
  return call(scope, `/custom-skills/${encodeURIComponent(name)}`, { method: 'PUT', body: def });
}
export async function deleteCustomSkillAction(scope: LifecycleScope, name: string) {
  return call(scope, `/custom-skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
export async function setHumanGatesAction(scope: LifecycleScope, gates: unknown) {
  return call(scope, `/human-gates`, { method: 'PUT', body: gates });
}
export async function applyOrgTemplateAction(
  scope: Extract<LifecycleScope, { kind: 'project' }>,
  templateName = 'default',
) {
  const session = await requireSession();
  await api(`/v1/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle/apply-template`, {
    method: 'POST',
    session,
    body: JSON.stringify({ name: templateName }),
  });
  revalidatePath(lifecycleRevalidatePath(scope));
}
