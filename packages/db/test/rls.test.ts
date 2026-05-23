/**
 * Cross-tenant RLS regression test (V1.0 exit criterion, #6).
 *
 * The runtime app role (`mergecrew_app`) does NOT bypass RLS, while the
 * superuser / migrator roles do. So this test connects through *two*
 * separate PrismaClients:
 *
 *   - migratorClient: privileged, used to create + delete the test orgs.
 *   - appClient:      RLS-enforced, used for the actual cross-tenant
 *                     visibility assertions. This is what the prod
 *                     api/runner/orchestrator services use at runtime.
 *
 * The test fails (loudly) if RLS is dormant — e.g. if someone points the
 * runtime URL at a superuser, or drops a `using (...)` from a policy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

function appUrl(): string {
  if (process.env.DATABASE_APP_URL) return process.env.DATABASE_APP_URL;
  // Fallback: rewrite DATABASE_URL's user/password to the app role. The
  // bootstrap SQL in infra/sql/init/00-roles.sql provisions the role with
  // password 'mergecrew_app' in dev + CI, so the rewrite is safe there.
  const base = process.env.DATABASE_URL ?? '';
  return base.replace(/^postgresql:\/\/[^@]+@/, 'postgresql://mergecrew_app:mergecrew_app@');
}

function migratorUrl(): string {
  if (process.env.DATABASE_MIGRATE_URL) return process.env.DATABASE_MIGRATE_URL;
  return process.env.DATABASE_URL ?? '';
}

const migratorClient = new PrismaClient({ datasources: { db: { url: migratorUrl() } } });
const appClient = new PrismaClient({ datasources: { db: { url: appUrl() } } });

const ORG_A_SLUG = `rls-test-a-${Date.now()}`;
const ORG_B_SLUG = `rls-test-b-${Date.now()}`;
let orgAId = '';
let orgBId = '';
let projectAId = '';
let projectBId = '';

beforeAll(async () => {
  const orgA = await migratorClient.organization.create({
    data: { slug: ORG_A_SLUG, name: 'RLS Test A' },
  });
  const orgB = await migratorClient.organization.create({
    data: { slug: ORG_B_SLUG, name: 'RLS Test B' },
  });
  orgAId = orgA.id;
  orgBId = orgB.id;

  const projectA = await migratorClient.project.create({
    data: { organizationId: orgAId, slug: 'a-only', name: 'A only' },
  });
  const projectB = await migratorClient.project.create({
    data: { organizationId: orgBId, slug: 'b-only', name: 'B only' },
  });
  projectAId = projectA.id;
  projectBId = projectB.id;
});

afterAll(async () => {
  // Cascade through the FKs — projects/memberships/etc. are deleted with the org.
  if (orgAId) {
    await migratorClient.organization.delete({ where: { id: orgAId } }).catch(() => {});
  }
  if (orgBId) {
    await migratorClient.organization.delete({ where: { id: orgBId } }).catch(() => {});
  }
  await migratorClient.$disconnect();
  await appClient.$disconnect();
});

async function withAppTenant<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return appClient.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`select set_config('app.org_id', $1, true)`, orgId);
    return fn(tx);
  });
}

describe('RLS: cross-tenant isolation (V1.0 exit criterion)', () => {
  it('migrator role sees both orgs (sanity — RLS is bypassed for the migrator)', async () => {
    const orgs = await migratorClient.organization.findMany({
      where: { slug: { in: [ORG_A_SLUG, ORG_B_SLUG] } },
      select: { slug: true },
    });
    expect(orgs.map((o) => o.slug).sort()).toEqual([ORG_A_SLUG, ORG_B_SLUG].sort());
  });

  it('within withTenant(orgA) the app role sees ONLY orgA projects', async () => {
    const visible = await withAppTenant(orgAId, async (tx) =>
      tx.project.findMany({ where: { id: { in: [projectAId, projectBId] } } }),
    );
    expect(visible.map((p: any) => p.id)).toEqual([projectAId]);
  });

  it('within withTenant(orgB) the app role sees ONLY orgB projects', async () => {
    const visible = await withAppTenant(orgBId, async (tx) =>
      tx.project.findMany({ where: { id: { in: [projectAId, projectBId] } } }),
    );
    expect(visible.map((p: any) => p.id)).toEqual([projectBId]);
  });

  it('within withTenant(orgA) the app role CANNOT update an orgB project', async () => {
    // RLS WITH CHECK on tenant_isolation rejects writes that would land
    // outside the active tenant. Prisma surfaces this as a "no rows
    // affected" updateMany count, not an exception.
    const r = await withAppTenant(orgAId, async (tx) =>
      tx.project.updateMany({
        where: { id: projectBId },
        data: { name: 'should not happen' },
      }),
    );
    expect(r.count).toBe(0);
  });

  it('without setting app.org_id at all, app-role queries fail (uuid cast)', async () => {
    // Stronger than "returns zero rows": the policy's
    // `(current_setting('app.org_id', true))::uuid` cast errors on the empty
    // default, which means a missing tenant context fails loudly at query
    // time. Either outcome (error / empty result) preserves isolation; this
    // assertion locks in the stricter "fail closed" behavior.
    await expect(
      appClient.project.findMany({ where: { id: { in: [projectAId, projectBId] } } }),
    ).rejects.toThrow(/uuid/);
  });

  it('within withTenant(orgA) the app role CANNOT insert into orgB', async () => {
    // The WITH CHECK on the policy forbids inserting rows whose
    // organization_id does not equal app.org_id. Postgres raises a
    // permission/policy violation.
    await expect(
      withAppTenant(orgAId, async (tx) =>
        tx.project.create({
          data: {
            organizationId: orgBId,
            slug: `evil-${Date.now()}`,
            name: 'should be rejected',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('runner_profile: cross-org read + write blocked under RLS', async () => {
    // Seed one row per org through the migrator (bypasses RLS).
    // Note: orgs created in beforeAll() did not exist at migration time
    // so the backfill did not run for them — that's expected.
    await migratorClient.runnerProfile.upsert({
      where: { organizationId: orgAId },
      create: { organizationId: orgAId, kind: 'instance_builtin' },
      update: {},
    });
    await migratorClient.runnerProfile.upsert({
      where: { organizationId: orgBId },
      create: { organizationId: orgBId, kind: 'none' },
      update: {},
    });

    // Under tenant A, B's profile must not be visible.
    const visibleAsA = await withAppTenant(orgAId, async (tx) =>
      tx.runnerProfile.findMany({ where: { organizationId: orgBId } }),
    );
    expect(visibleAsA).toEqual([]);

    // Under tenant A, attempting to update B's profile must affect zero rows.
    const updated = await withAppTenant(orgAId, async (tx) =>
      tx.runnerProfile.updateMany({
        where: { organizationId: orgBId },
        data: { kind: 'agent' },
      }),
    );
    expect(updated.count).toBe(0);
  });

  it('runner_agent: cross-org read + write blocked under RLS', async () => {
    // Create one agent per org through the migrator (bypasses RLS).
    const seededAgentB = await migratorClient.runnerAgent.create({
      data: {
        organizationId: orgBId,
        name: 'b-agent',
        tokenHash: `tokenhash-b-${Date.now()}`,
        prefix: `mca_${ORG_B_SLUG.slice(0, 6)}_xxxxxx`,
      },
    });

    // Under tenant A, B's agent must not be visible.
    const visibleAgents = await withAppTenant(orgAId, async (tx) =>
      tx.runnerAgent.findMany({ where: { id: seededAgentB.id } }),
    );
    expect(visibleAgents).toEqual([]);

    // Under tenant A, attempt to insert an agent into B's org must fail.
    await expect(
      withAppTenant(orgAId, async (tx) =>
        tx.runnerAgent.create({
          data: {
            organizationId: orgBId,
            name: 'evil',
            tokenHash: `evil-${Date.now()}`,
            prefix: 'mca_xxxxxx_xxxxxx',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
