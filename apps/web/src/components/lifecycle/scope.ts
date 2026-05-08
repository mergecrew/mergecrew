export type LifecycleScope =
  | { kind: 'project'; orgSlug: string; projectSlug: string }
  | { kind: 'org-template'; orgSlug: string; templateName: string };

/** Build the base API path for the lifecycle editor's HTTP calls. */
export function lifecycleBasePath(scope: LifecycleScope): string {
  if (scope.kind === 'project') {
    return `/v1/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle`;
  }
  return `/v1/orgs/${scope.orgSlug}/lifecycle-templates/${scope.templateName}`;
}

/** Path to revalidate after a mutation. */
export function lifecycleRevalidatePath(scope: LifecycleScope): string {
  if (scope.kind === 'project') {
    return `/orgs/${scope.orgSlug}/projects/${scope.projectSlug}/lifecycle`;
  }
  return `/orgs/${scope.orgSlug}/lifecycle-templates/${scope.templateName}`;
}
