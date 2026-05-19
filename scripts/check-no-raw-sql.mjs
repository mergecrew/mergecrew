#!/usr/bin/env node
/**
 * Raw-SQL chokepoint check (#582 / #554 T-9).
 *
 * The runner's Prisma client runs as a role that bypasses RLS so the
 * supervisor can read across tenant rows for orchestration. Every
 * regular query routes through `withTenant(orgId, …)` so RLS still
 * gates per-tenant tables. A `$queryRaw` / `$executeRaw` call with
 * user-controlled input would bypass that boundary.
 *
 * Rule: `$queryRaw*` and `$executeRaw*` are confined to `packages/db/**`
 * (where the withTenant helpers bind the org id before the SQL runs).
 * Existing call sites outside that allowlist must carry an inline
 * `// eslint-disable-next-line no-restricted-syntax` comment with a
 * justification, mirrored in the safelist of
 * `docs/02-architecture/11-security.md` § Raw SQL allowlist.
 *
 * This script is the CI gate. Exits 1 with the offending file:line
 * list when a violation is found, 0 otherwise.
 *
 * We use a grep-based scan instead of an ESLint rule because the rest
 * of the repo's lint setup has lots of pre-existing errors unrelated
 * to security — running the focused chokepoint check in isolation
 * keeps the signal clean and the CI step independent of broader lint
 * cleanup.
 *
 * Run via `pnpm lint:no-raw-sql` (root) or as a CI step (see
 * `.github/workflows/ci.yml` § "Raw SQL chokepoint").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paths searched. We don't scan `packages/db/**` (the allowlist) and
// we skip generated output, node_modules, and test fixtures.
const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'generated',
  '__generated__',
]);
const ALLOWLIST_PREFIXES = [
  'packages/db/',
  // Test fixture used to verify the lint actually fires.
  'packages/db/test/fixtures/raw-sql-violation/',
];

const RAW_API_RE = /\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b/;
const DISABLE_RE = /eslint-disable-next-line\s+no-restricted-syntax/;

const offenders = [];

function shouldScanFile(relPath) {
  if (!relPath.endsWith('.ts') && !relPath.endsWith('.tsx')) return false;
  if (relPath.endsWith('.d.ts')) return false;
  for (const prefix of ALLOWLIST_PREFIXES) {
    if (relPath.startsWith(prefix)) return false;
  }
  return true;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = path.relative(ROOT, full);
    if (!shouldScanFile(rel)) continue;
    const body = readFileSync(full, 'utf8');
    if (!RAW_API_RE.test(body)) continue;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!RAW_API_RE.test(lines[i] ?? '')) continue;
      // Look at the previous line for a disable directive. ESLint's
      // own resolution would also accept same-line `eslint-disable-line`
      // but we keep this strict: the comment must be the line above.
      const prev = lines[i - 1] ?? '';
      if (DISABLE_RE.test(prev)) continue;
      offenders.push({ file: rel, line: i + 1, snippet: lines[i].trim() });
    }
  }
}

for (const d of SCAN_DIRS) walk(path.join(ROOT, d));

if (offenders.length > 0) {
  console.error(
    '\nRaw SQL chokepoint violation (#582 / #554 T-9): the following call sites use a Prisma raw-SQL API outside packages/db/** without a justification:\n',
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.snippet}`);
  }
  console.error(
    '\nFix: move the call into packages/db/, OR add a line-above comment:',
  );
  console.error('  // eslint-disable-next-line no-restricted-syntax -- <one-line justification>');
  console.error(
    'and append the entry to docs/02-architecture/11-security.md § Raw SQL allowlist.\n',
  );
  process.exit(1);
}

console.log('raw-SQL chokepoint ok — apps/ packages/ (allowlist: packages/db/**)');
