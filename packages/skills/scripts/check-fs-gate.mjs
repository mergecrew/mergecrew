#!/usr/bin/env node
/**
 * Path-gate enforcement (#580 / #554 T-10).
 *
 * Scans every TypeScript file under `src/stock/` for raw `fs.*` calls
 * (readFile, writeFile, mkdir, …) that take a path the LLM might
 * control. If the file uses any `fs` API, it must also import the
 * workspace-path helpers so paths get normalized + traversal-checked
 * before they ever land in a syscall.
 *
 * This is a coarse check on purpose — false positives are fine, the
 * fix is to thread paths through `resolveWorkspacePath`. False negatives
 * (a path that bypasses the helper and the script misses it) is the
 * thing we care about; that's why the rule fires on *any* fs.* call in
 * a stock skill that doesn't import the helper.
 *
 * Exits 1 with a list of offending files when violations are found.
 *
 * Run via `pnpm --filter @mergecrew/skills lint:fs-gate` or as a CI
 * step — see `.github/workflows/ci.yml` § "skills path-gate".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'stock');

// fs APIs that take a path. `existsSync`, `realpath` etc. are also
// path-taking but read-only; keep the list focused on what can leak or
// overwrite arbitrary files. Add to this list when new APIs land.
const FS_API_RE = /(?:^|[^a-zA-Z0-9_])fs\.(?:promises\.)?(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createReadStream|createWriteStream|chmod|chmodSync|chown|chownSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync)\b/;

// The acceptable gates. Any file that uses fs.* and ALSO imports one
// of these is considered safe.
const SAFE_IMPORT_RE = /from '\.\.\/workspace\.js'/;

const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.d.ts')) continue;
    const body = readFileSync(full, 'utf8');
    if (!FS_API_RE.test(body)) continue;
    if (SAFE_IMPORT_RE.test(body)) continue;
    offenders.push(path.relative(process.cwd(), full));
  }
}

walk(ROOT);

if (offenders.length > 0) {
  console.error(
    '\nskills path-gate violation (#580 / #554 T-10): the following stock skill files use a path-taking fs.* API but do not import the workspace-path helpers:\n',
  );
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(
    `\nFix: route every user-controlled path through resolveWorkspacePath (or resolveExistingWorkspacePath for reads of files that already exist) — see packages/skills/src/workspace.ts.\n`,
  );
  process.exit(1);
}

console.log(`skills path-gate ok — ${ROOT}`);
