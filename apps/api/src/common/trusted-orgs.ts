/**
 * Trusted-org allowlist for the `instance_builtin` runner profile
 * (ADR-0006). Only orgs returned by `isTrustedOrgSlug` may select
 * `kind=instance_builtin` for their `runner_profile`; all other orgs
 * must bring their own runner.
 *
 * Two envs feed the allowlist:
 *
 *   MERGECREW_TRUSTED_ORG_SLUGS — comma-separated list, e.g. "acme,beta"
 *   MERGECREW_OWNER_ORG_SLUG   — single slug; implicitly included
 *
 * Single-tenant self-host installs typically set just the second one
 * (the org created during seed/setup) — same behavior as before this
 * milestone, no new ops chore. Multi-tenant operators set the first.
 *
 * Both unset => no org is trusted; every org defaults to `kind=none`
 * (ADR-0008) and must configure a BYO runner profile.
 *
 * The env is read on each call so a config-reloading deployment can
 * change trust without restarting the API. The parse is cheap (a few
 * comma splits) but if profiling ever flags it, memoize on env-value.
 */
export function isTrustedOrgSlug(slug: string): boolean {
  if (!slug) return false;
  return trustedOrgSlugSet().has(slug);
}

export function trustedOrgSlugSet(): Set<string> {
  const set = new Set<string>();
  const list = (process.env.MERGECREW_TRUSTED_ORG_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of list) set.add(s);
  const owner = (process.env.MERGECREW_OWNER_ORG_SLUG ?? '').trim();
  if (owner) set.add(owner);
  return set;
}
