/**
 * Connection-URL selection for the three database roles:
 *
 *   - prisma.config.ts: migrations run as the migrator (#895).
 *   - getSystemPrisma(): cross-tenant queries use DATABASE_SYSTEM_URL
 *     and fail closed in production instead of falling back to the
 *     migrator / table owner.
 *
 * Pure env-in/URL-out tests; no database needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMigrationUrl } from '../prisma.config.js';
import { resolveSystemDatabaseUrl } from '../src/client.js';

const APP = 'postgresql://mergecrew_app:a@db:5432/mergecrew';
const SYSTEM = 'postgresql://mergecrew_system:s@db:5432/mergecrew';
const MIGRATE = 'postgresql://mergecrew_migrator:m@db:5432/mergecrew';

describe('resolveMigrationUrl (prisma.config.ts, #895)', () => {
  it('prefers DATABASE_MIGRATE_URL over DATABASE_URL', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: APP, DATABASE_MIGRATE_URL: MIGRATE })).toBe(MIGRATE);
  });

  it('falls back to DATABASE_URL when no migrator URL is set (CI / single-URL setups)', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: APP })).toBe(APP);
  });

  it('treats an empty DATABASE_MIGRATE_URL as unset', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: APP, DATABASE_MIGRATE_URL: '' })).toBe(APP);
    expect(resolveMigrationUrl({ DATABASE_URL: APP, DATABASE_MIGRATE_URL: '  ' })).toBe(APP);
  });

  it("returns '' when nothing is set so `prisma generate` still loads the config", () => {
    expect(resolveMigrationUrl({})).toBe('');
  });

  it('never selects DATABASE_SYSTEM_URL', () => {
    expect(resolveMigrationUrl({ DATABASE_URL: APP, DATABASE_SYSTEM_URL: SYSTEM })).toBe(APP);
  });
});

describe('prisma.config.ts default export', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires datasource.url to the migrator URL', async () => {
    vi.stubEnv('DATABASE_URL', APP);
    vi.stubEnv('DATABASE_MIGRATE_URL', MIGRATE);
    const mod = await import('../prisma.config.js');
    expect(mod.default.datasource?.url).toBe(MIGRATE);
  });
});

describe('resolveSystemDatabaseUrl (getSystemPrisma)', () => {
  it('uses DATABASE_SYSTEM_URL when set', () => {
    expect(
      resolveSystemDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: APP,
        DATABASE_SYSTEM_URL: SYSTEM,
      }),
    ).toEqual({ source: 'system', url: SYSTEM });
  });

  it('prefers DATABASE_SYSTEM_URL over DATABASE_MIGRATE_URL outside production', () => {
    expect(
      resolveSystemDatabaseUrl({ DATABASE_SYSTEM_URL: SYSTEM, DATABASE_MIGRATE_URL: MIGRATE }),
    ).toEqual({ source: 'system', url: SYSTEM });
  });

  describe('production fails closed', () => {
    it('throws when DATABASE_SYSTEM_URL is unset, even if the migrator URL is present', () => {
      expect(() =>
        resolveSystemDatabaseUrl({
          NODE_ENV: 'production',
          DATABASE_URL: APP,
          DATABASE_MIGRATE_URL: MIGRATE,
        }),
      ).toThrow(/DATABASE_SYSTEM_URL is required in production/);
    });

    it('throws when DATABASE_SYSTEM_URL is unset and only DATABASE_URL exists', () => {
      expect(() => resolveSystemDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: APP })).toThrow(
        /DATABASE_SYSTEM_URL is required/,
      );
    });

    it('treats an empty DATABASE_SYSTEM_URL as unset', () => {
      expect(() =>
        resolveSystemDatabaseUrl({
          NODE_ENV: 'production',
          DATABASE_SYSTEM_URL: '',
          DATABASE_MIGRATE_URL: MIGRATE,
        }),
      ).toThrow(/DATABASE_SYSTEM_URL is required/);
    });

    it('rejects a DATABASE_SYSTEM_URL that is just the migrator URL', () => {
      expect(() =>
        resolveSystemDatabaseUrl({
          NODE_ENV: 'production',
          DATABASE_SYSTEM_URL: MIGRATE,
          DATABASE_MIGRATE_URL: MIGRATE,
        }),
      ).toThrow(/must not equal DATABASE_MIGRATE_URL/);
    });
  });

  describe('dev / test fallbacks', () => {
    it('falls back to DATABASE_MIGRATE_URL', () => {
      expect(
        resolveSystemDatabaseUrl({ NODE_ENV: 'development', DATABASE_MIGRATE_URL: MIGRATE }),
      ).toEqual({ source: 'migrate-fallback', url: MIGRATE });
    });

    it('falls back to the app client when nothing else is set', () => {
      expect(resolveSystemDatabaseUrl({ DATABASE_URL: APP })).toEqual({ source: 'app-fallback' });
    });
  });
});

describe('getSystemPrisma', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws in production without DATABASE_SYSTEM_URL instead of using the migrator', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', APP);
    vi.stubEnv('DATABASE_MIGRATE_URL', MIGRATE);
    vi.stubEnv('DATABASE_SYSTEM_URL', '');
    const { getSystemPrisma, withSystem } = await import('../src/client.js');
    expect(() => getSystemPrisma()).toThrow(/DATABASE_SYSTEM_URL is required in production/);
    await expect(withSystem(async () => 'unreachable')).rejects.toThrow(
      /DATABASE_SYSTEM_URL is required in production/,
    );
  });
});
