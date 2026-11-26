import type { Logger } from 'pino';
import { isTrustedOrgId, legacyTrustedSlugEnvSet, trustedOrgIdSet } from '@mergecrew/domain';

/**
 * Dispatch-time trust gate for the `instance_builtin` runner (ADR-0006).
 *
 * The API refuses to *select* `instance_builtin` for untrusted orgs, but
 * the DB row is not the source of truth for trust: rows could have been
 * backfilled by the V2.af migration, written while trust was keyed on a
 * (renameable) slug, or left behind after the operator removed an org
 * from the allowlist. The orchestrator therefore re-checks the org UUID
 * against the env allowlist on every dispatch and fails closed.
 */
export function effectiveRunnerKind(kind: string, organizationId: string): string {
  if (kind === 'instance_builtin' && !isTrustedOrgId(organizationId)) {
    return 'instance_builtin_untrusted';
  }
  return kind;
}

interface RunnerProfileClient {
  runnerProfile: {
    updateMany(args: {
      where: { kind: 'instance_builtin'; organizationId: { notIn: string[] } };
      data: { kind: 'none' };
    }): Promise<{ count: number }>;
  };
}

/**
 * Boot-time cleanup: downgrade every `instance_builtin` profile whose org
 * is not in the UUID allowlist to `none`. Covers the V2.af migration
 * backfill (which set every pre-existing org to `instance_builtin`) and
 * any row created under the old slug-based trust. Idempotent.
 */
export async function downgradeUntrustedBuiltinProfiles(
  client: RunnerProfileClient,
  logger: Pick<Logger, 'warn' | 'info'>,
): Promise<number> {
  if (legacyTrustedSlugEnvSet()) {
    logger.warn(
      'MERGECREW_TRUSTED_ORG_SLUGS / MERGECREW_OWNER_ORG_SLUG are no longer honoured; ' +
        'set MERGECREW_TRUSTED_ORG_IDS / MERGECREW_OWNER_ORG_ID (org UUIDs) instead',
    );
  }
  const trusted = Array.from(trustedOrgIdSet());
  const { count } = await client.runnerProfile.updateMany({
    where: { kind: 'instance_builtin', organizationId: { notIn: trusted } },
    data: { kind: 'none' },
  });
  if (count > 0) {
    logger.warn(
      { count },
      'runner.trust: downgraded instance_builtin runner profiles of untrusted orgs to none',
    );
  }
  return count;
}
