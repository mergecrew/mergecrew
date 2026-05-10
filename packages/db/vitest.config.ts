import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The RLS regression test needs DATABASE_URL + DATABASE_MIGRATE_URL to point
// at a real Postgres. Load the repo-root .env up front so `pnpm test` from
// the workspace root works without an external `set -a; source .env`.
// CI sets these via the workflow env block; .env is absent there but the
// vars are already populated, so dotenv is a no-op.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../.env') });

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
