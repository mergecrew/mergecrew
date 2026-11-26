/**
 * Org ↔ GitHub App installation binding checks.
 *
 * A GitHub App installation id is only usable by the organization it is
 * bound to in `org_github_installations` (written by the install
 * callback once GitHub confirms the installing user can access it).
 * Every path that lists repos for, connects, or mints tokens for an
 * installation must call one of these first.
 */

/** Minimal tx surface so callers can pass a tenant tx or a test fake. */
export interface InstallationBindingReader {
  orgGithubInstallation: {
    findFirst(args: {
      where: { organizationId: string; installationId: string; suspendedAt: null };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export class InstallationNotBoundError extends Error {
  readonly code = 'INSTALLATION_NOT_BOUND';
  constructor(readonly installationId: string) {
    super(`GitHub App installation ${installationId} is not bound to this organization`);
    this.name = 'InstallationNotBoundError';
  }
}

/**
 * True when `installationId` is bound (and not suspended) to
 * `organizationId`. Malformed ids are never bound.
 */
export async function isInstallationBoundToOrg(
  tx: InstallationBindingReader,
  organizationId: string,
  installationId: string,
): Promise<boolean> {
  if (!organizationId || !installationId || !/^\d+$/.test(installationId)) return false;
  const row = await tx.orgGithubInstallation.findFirst({
    where: { organizationId, installationId, suspendedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/** Throws {@link InstallationNotBoundError} unless the binding exists. */
export async function assertInstallationBoundToOrg(
  tx: InstallationBindingReader,
  organizationId: string,
  installationId: string,
): Promise<void> {
  if (!(await isInstallationBoundToOrg(tx, organizationId, installationId))) {
    throw new InstallationNotBoundError(installationId);
  }
}
