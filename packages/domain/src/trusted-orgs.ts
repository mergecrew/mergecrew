/**
 * Trusted-org allowlist for the `instance_builtin` runner profile
 * (ADR-0006). Only orgs whose **UUID** appears here may run work on the
 * deployment's built-in runner; every other org must bring its own
 * runner (ADR-0008).
 *
 * Trust is keyed on the immutable organization id rather than the slug:
 * slugs are user-chosen at org creation and can be renamed by any org
 * admin, so a slug-based allowlist could be claimed by whoever creates
 * (or renames an org to) a configured-but-unclaimed slug.
 *
 *   MERGECREW_TRUSTED_ORG_IDS — comma-separated org UUIDs
 *   MERGECREW_OWNER_ORG_ID    — single org UUID; implicitly trusted
 *
 * Both unset => no org is trusted; the deployment is BYO-only.
 *
 * The legacy `MERGECREW_TRUSTED_ORG_SLUGS` / `MERGECREW_OWNER_ORG_SLUG`
 * variables are intentionally ignored (see `legacyTrustedSlugEnvSet`).
 *
 * The env is read on each call so the API's create/update paths and the
 * orchestrator's dispatch-time re-check always agree with the current
 * configuration.
 */

type Env = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function trustedOrgIdSet(env: Env = process.env): Set<string> {
  const set = new Set<string>();
  const add = (raw: string) => {
    const id = raw.trim().toLowerCase();
    if (UUID_RE.test(id)) set.add(id);
  };
  for (const s of (env.MERGECREW_TRUSTED_ORG_IDS ?? '').split(',')) add(s);
  add(env.MERGECREW_OWNER_ORG_ID ?? '');
  return set;
}

export function isTrustedOrgId(organizationId: string | null | undefined, env: Env = process.env): boolean {
  if (!organizationId) return false;
  return trustedOrgIdSet(env).has(organizationId.trim().toLowerCase());
}

/**
 * True when the operator still sets the removed slug-based trust vars.
 * Callers log a warning at boot so the migration to `*_ID` is visible.
 */
export function legacyTrustedSlugEnvSet(env: Env = process.env): boolean {
  return Boolean(
    (env.MERGECREW_TRUSTED_ORG_SLUGS ?? '').trim() || (env.MERGECREW_OWNER_ORG_SLUG ?? '').trim(),
  );
}
