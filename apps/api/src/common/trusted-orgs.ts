/**
 * Trusted-org allowlist for the `instance_builtin` runner profile
 * (ADR-0006). Trust is keyed on the immutable organization UUID via
 * `MERGECREW_TRUSTED_ORG_IDS` / `MERGECREW_OWNER_ORG_ID`; see
 * `@mergecrew/domain`'s `trusted-orgs.ts` for the parsing rules.
 *
 * Slug-based trust (`MERGECREW_TRUSTED_ORG_SLUGS` /
 * `MERGECREW_OWNER_ORG_SLUG`) was removed: slugs are user-chosen and
 * renameable, so they can't anchor access to the operator's runner.
 */
export { isTrustedOrgId, trustedOrgIdSet, legacyTrustedSlugEnvSet } from '@mergecrew/domain';
