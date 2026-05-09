import { roleAtLeast, type OrgRole } from '@mergecrew/domain';
import { api, type Session } from './api';

interface OrgEntry {
  slug: string;
  name: string;
  role: OrgRole;
}

/**
 * Returns the user's role in the given org, or null if they don't belong to
 * it (or the API is unreachable). Failures collapse to null on purpose so
 * UI gates default closed.
 */
export async function getOrgRole(orgSlug: string, session: Session): Promise<OrgRole | null> {
  try {
    const res = await api<{ items: OrgEntry[] }>('/v1/orgs', { session });
    return res.items.find((o) => o.slug === orgSlug)?.role ?? null;
  } catch {
    return null;
  }
}

/**
 * True when the user has at least the given role in the org. Used to gate
 * lifecycle-editor write affordances; the API still enforces RoleGuard
 * server-side.
 */
export async function hasRole(
  orgSlug: string,
  session: Session,
  required: OrgRole,
): Promise<boolean> {
  const role = await getOrgRole(orgSlug, session);
  return role ? roleAtLeast(role, required) : false;
}
