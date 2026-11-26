import { defineConfig } from 'vitest/config';

// Unit tests for pure BFF helpers (no Next.js runtime). Files under test
// avoid the `@/` alias so they resolve without extra config.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
