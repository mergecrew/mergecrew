import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/web/.next/**',
      '**/prisma/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  // Raw-SQL chokepoint (#582 / #554 T-9). The runner's Prisma client
  // runs as a role that bypasses RLS; any `$queryRaw` / `$executeRaw`
  // call with user-controlled input is a cross-tenant-read foot-gun.
  // Confine these APIs to `packages/db/**`, where the helpers
  // `withTenant` + `withTenantTx` make sure the org-id is bound before
  // any raw SQL runs.
  //
  // Allowlist: extend `files` below — never add a project-wide ignore
  // for this rule. The architecture doc tracks the safe-list:
  // docs/02-architecture/11-security.md § Raw SQL allowlist.
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: [
      'packages/db/**',
      // Test fixtures intentionally violate the rule to assert it fires.
      '**/test/fixtures/raw-sql-violation/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^\\$(queryRaw|executeRaw)/]',
          message:
            'Raw Prisma SQL ($queryRaw, $executeRaw, $queryRawUnsafe, $executeRawUnsafe) is confined to packages/db/** so the cross-tenant-read gate via withTenant() holds. See docs/02-architecture/11-security.md § Raw SQL allowlist.',
        },
      ],
    },
  },
];
