import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFixtures, loadFixture } from '../src/load.js';

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length) {
    const p = cleanups.pop()!;
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }
});

describe('eval fixtures', () => {
  it('lists at least the 5 V2.ab starter fixtures', async () => {
    const ids = await listFixtures();
    expect(ids).toEqual(
      expect.arrayContaining([
        'node-express-small',
        'python-flask-small',
        'go-stdlib-small',
        'monorepo-pnpm',
        'docs-only',
      ]),
    );
  });

  it('loads each fixture into a clean tempdir with manifest fields populated', async () => {
    const ids = await listFixtures();
    for (const id of ids) {
      const loaded = await loadFixture(id);
      cleanups.push(loaded.workspacePath);

      expect(loaded.manifest.id).toBe(id);
      expect(loaded.manifest.description.length).toBeGreaterThan(0);
      expect(loaded.manifest.intent.length).toBeGreaterThan(0);
      expect(loaded.manifest.expectedFiles.length).toBeGreaterThanOrEqual(1);

      // Workspace has source files but no manifest / expected.diff leak.
      const top = await fs.readdir(loaded.workspacePath);
      expect(top.length).toBeGreaterThan(0);
      expect(top).not.toContain('manifest.yaml');
      expect(top).not.toContain('expected.diff');

      // expected.diff lives at the original source location.
      const expectedExists = await fs
        .access(loaded.expectedDiffPath)
        .then(() => true)
        .catch(() => false);
      expect(expectedExists).toBe(true);
    }
  });

  it('rejects an unknown fixture id', async () => {
    await expect(loadFixture('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('isolates each load — two loadFixture calls produce distinct tempdirs', async () => {
    const a = await loadFixture('node-express-small');
    const b = await loadFixture('node-express-small');
    cleanups.push(a.workspacePath, b.workspacePath);
    expect(a.workspacePath).not.toBe(b.workspacePath);

    // Modifying one workspace must not affect the other.
    await fs.writeFile(path.join(a.workspacePath, 'SCRIBBLE'), 'a');
    const bHasScribble = await fs
      .access(path.join(b.workspacePath, 'SCRIBBLE'))
      .then(() => true)
      .catch(() => false);
    expect(bHasScribble).toBe(false);
  });
});
