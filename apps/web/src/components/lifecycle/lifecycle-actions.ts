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

/**
 * Replace the project's lifecycle from a YAML string (#270). The
 * editor validates client-side before invoking this; the API still
 * re-validates as the second wall.
 */
export async function upsertLifecycleYamlAction(scope: LifecycleScope, yaml: string) {
  return call(scope, ``, { method: 'PUT', body: { yaml } });
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

/**
 * Persist node positions for the graph view (V2.1 phase 2, #195).
 * Project-scope only — org-scope templates have no graph view yet.
 * Skips revalidatePath: the graph layout is decoration on top of the
 * lifecycle, and re-fetching the whole page on every drag would
 * kill the UX.
 */
export async function saveGraphLayoutAction(
  scope: Extract<LifecycleScope, { kind: 'project' }>,
  positions: Record<string, { x: number; y: number }>,
) {
  const session = await requireSession();
  await api(
    `/v1/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle/graph-layout`,
    {
      method: 'PUT',
      session,
      body: JSON.stringify({ positions }),
    },
  );
}

/**
 * Edits to the lifecycle topology (rename workflow, add/remove edge,
 * add/remove agent) open a PR against the project's `mergecrew.yaml`
 * via the API service in apps/api/src/modules/lifecycle/lifecycle-pr.service.ts
 * (V2.1 phase 3, #196). The shape mirrors @mergecrew/config-yaml's GraphEdit
 * union — kept locally rather than imported so the server-only YAML CST code
 * doesn't get pulled into the web bundle.
 */
export type GraphEdit =
  | { kind: 'rename_workflow'; from: string; to: string }
  | { kind: 'add_edge'; from: string; to: string }
  | { kind: 'remove_edge'; from: string; to: string }
  | { kind: 'add_agent'; workflow: string; agent: string }
  | { kind: 'remove_agent'; workflow: string; agent: string };

export interface GraphEditPrResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  baseHash: string;
}
export interface GraphEditPrStale {
  stale: true;
  currentHash: string;
}

export async function getGraphEditBaseAction(
  scope: Extract<LifecycleScope, { kind: 'project' }>,
): Promise<{ baseHash: string | null }> {
  const session = await requireSession();
  return api<{ baseHash: string | null }>(
    `/v1/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle/graph-edit-base`,
    { session },
  );
}

export async function openGraphEditPrAction(
  scope: Extract<LifecycleScope, { kind: 'project' }>,
  edits: GraphEdit[],
  baseHash: string | null,
): Promise<GraphEditPrResult | GraphEditPrStale> {
  const session = await requireSession();
  return api<GraphEditPrResult | GraphEditPrStale>(
    `/v1/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle/graph-edit-pr`,
    {
      method: 'POST',
      session,
      body: JSON.stringify({ edits, baseHash }),
    },
  );
}
