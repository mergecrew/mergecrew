import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The `fixtures/` tree contains intentionally-broken sample
    // projects (sometimes with their own test files acting as the
    // spec the agent must satisfy). Don't pick those up as
    // workspace-level tests.
    include: ['test/**/*.test.ts'],
    exclude: ['fixtures/**', 'node_modules/**', 'dist/**'],
  },
});
