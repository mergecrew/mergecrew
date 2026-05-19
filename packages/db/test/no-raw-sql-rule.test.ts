import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function runScript(cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('node', ['scripts/check-no-raw-sql.mjs'], {
    cwd,
    encoding: 'utf8',
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Acceptance test for the raw-SQL chokepoint check (#582 / #554 T-9).
 *
 * Copies the fixture into a scratch repo with the script + an `apps/`
 * shadow tree, runs the script, and asserts the rule fires.
 *
 * Kept in `packages/db/test/` (not co-located with the fixture) so
 * vitest picks it up via the normal glob.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURE_FILE = path.join(HERE, 'fixtures', 'raw-sql-violation', 'violation.ts');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-no-raw-sql.mjs');

describe('check-no-raw-sql.mjs', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-sql-rule-'));
    // Mirror the layout the real script scans (`apps/` and `packages/`)
    // plus a stub `scripts/` to host a copy of the check itself.
    await fs.mkdir(path.join(workdir, 'apps', 'some-app', 'src'), { recursive: true });
    await fs.mkdir(path.join(workdir, 'packages', 'db'), { recursive: true });
    await fs.mkdir(path.join(workdir, 'scripts'), { recursive: true });
    await fs.copyFile(SCRIPT, path.join(workdir, 'scripts', 'check-no-raw-sql.mjs'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('exits 1 when an unjustified raw-SQL call lives outside packages/db', async () => {
    const fixture = await fs.readFile(FIXTURE_FILE, 'utf8');
    await fs.writeFile(path.join(workdir, 'apps', 'some-app', 'src', 'violation.ts'), fixture);
    const r = runScript(workdir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Raw SQL chokepoint violation');
    expect(r.stderr).toContain('apps/some-app/src/violation.ts');
  });

  it('exits 0 when the same call lives inside packages/db', async () => {
    const fixture = await fs.readFile(FIXTURE_FILE, 'utf8');
    await fs.writeFile(path.join(workdir, 'packages', 'db', 'allowed.ts'), fixture);
    const r = runScript(workdir);
    expect(r.exitCode).toBe(0);
  });

  it('exits 0 when the call has an eslint-disable-next-line comment with a justification', async () => {
    await fs.writeFile(
      path.join(workdir, 'apps', 'some-app', 'src', 'justified.ts'),
      `declare const tx: any;
export async function f() {
  // eslint-disable-next-line no-restricted-syntax -- healthcheck, no input
  return tx.$queryRaw\`select 1\`;
}
`,
    );
    const r = runScript(workdir);
    expect(r.exitCode).toBe(0);
  });

  it('catches $executeRawUnsafe as well as $queryRaw', async () => {
    await fs.writeFile(
      path.join(workdir, 'apps', 'some-app', 'src', 'execute.ts'),
      `declare const tx: any;
export async function f() {
  return tx.$executeRawUnsafe('drop table users');
}
`,
    );
    const r = runScript(workdir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('apps/some-app/src/execute.ts');
  });
});
