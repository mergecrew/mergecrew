import { describe, expect, it } from 'vitest';
import {
  assertInstallationBoundToOrg,
  InstallationNotBoundError,
  isInstallationBoundToOrg,
  type InstallationBindingReader,
} from '../src/github-installation.js';

const ORG_A = '00000000-0000-0000-0000-00000000000a';
const ORG_B = '00000000-0000-0000-0000-00000000000b';

function fakeTx(
  rows: Array<{ organizationId: string; installationId: string; suspendedAt: Date | null }>,
): InstallationBindingReader & { calls: number } {
  const tx = {
    calls: 0,
    orgGithubInstallation: {
      async findFirst(args: {
        where: { organizationId: string; installationId: string; suspendedAt: null };
      }) {
        tx.calls += 1;
        const hit = rows.find(
          (r) =>
            r.organizationId === args.where.organizationId &&
            r.installationId === args.where.installationId &&
            r.suspendedAt === null,
        );
        return hit ? { id: 'row' } : null;
      },
    },
  };
  return tx;
}

describe('isInstallationBoundToOrg', () => {
  const tx = fakeTx([
    { organizationId: ORG_A, installationId: '111', suspendedAt: null },
    { organizationId: ORG_A, installationId: '222', suspendedAt: new Date() },
  ]);

  it('accepts an installation bound to the org', async () => {
    expect(await isInstallationBoundToOrg(tx, ORG_A, '111')).toBe(true);
  });

  it("rejects another org's installation", async () => {
    expect(await isInstallationBoundToOrg(tx, ORG_B, '111')).toBe(false);
  });

  it('rejects a suspended binding', async () => {
    expect(await isInstallationBoundToOrg(tx, ORG_A, '222')).toBe(false);
  });

  it('rejects unknown and malformed ids without querying', async () => {
    const t = fakeTx([]);
    expect(await isInstallationBoundToOrg(t, ORG_A, '999')).toBe(false);
    expect(t.calls).toBe(1);
    expect(await isInstallationBoundToOrg(t, ORG_A, 'manual')).toBe(false);
    expect(await isInstallationBoundToOrg(t, ORG_A, '')).toBe(false);
    expect(await isInstallationBoundToOrg(t, '', '111')).toBe(false);
    expect(t.calls).toBe(1);
  });
});

describe('assertInstallationBoundToOrg', () => {
  const tx = fakeTx([{ organizationId: ORG_A, installationId: '111', suspendedAt: null }]);

  it('resolves when bound', async () => {
    await expect(assertInstallationBoundToOrg(tx, ORG_A, '111')).resolves.toBeUndefined();
  });

  it('throws InstallationNotBoundError when not bound', async () => {
    await expect(assertInstallationBoundToOrg(tx, ORG_B, '111')).rejects.toBeInstanceOf(
      InstallationNotBoundError,
    );
  });
});
