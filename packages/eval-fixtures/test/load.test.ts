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
      // expectedFiles is required ≥1 for end-to-end + agent='planner'
      // fixtures. agent='reviewer' fixtures score on expectedVerdict
      // not on file paths and may carry an empty list.
      if (loaded.manifest.agentKind !== 'reviewer') {
        expect(loaded.manifest.expectedFiles.length).toBeGreaterThanOrEqual(1);
      }

      // Workspace has source files but no manifest / expected.diff leak.
      const top = await fs.readdir(loaded.workspacePath);
      expect(top).not.toContain('manifest.yaml');
      expect(top).not.toContain('expected.diff');

      // expected.diff lives at the original source location — only
      // for kinds that score against a diff (end-to-end + coder).
      const needsExpectedDiff =
        loaded.manifest.kind === 'end-to-end' || loaded.manifest.agentKind === 'coder';
      if (needsExpectedDiff) {
        const expectedExists = await fs
          .access(loaded.expectedDiffPath)
          .then(() => true)
          .catch(() => false);
        expect(expectedExists).toBe(true);
      }
    }
  });

  it('loads the new agent-isolation fixtures with the right kind metadata (#337)', async () => {
    const planner = await loadFixture('planner-finds-the-bug');
    cleanups.push(planner.workspacePath);
    expect(planner.manifest.kind).toBe('agent');
    expect(planner.manifest.agentKind).toBe('planner');

    const coder = await loadFixture('coder-implements-the-plan');
    cleanups.push(coder.workspacePath);
    expect(coder.manifest.kind).toBe('agent');
    expect(coder.manifest.agentKind).toBe('coder');
    expect(coder.manifest.planMarkdown).toContain('Files to touch');

    const reviewer = await loadFixture('reviewer-flags-out-of-scope');
    cleanups.push(reviewer.workspacePath);
    expect(reviewer.manifest.kind).toBe('agent');
    expect(reviewer.manifest.agentKind).toBe('reviewer');
    expect(reviewer.manifest.expectedVerdict).toBe('request_changes');
    expect(reviewer.manifest.diffMarkdown).toContain('src/routes/health.ts');
  });

  it('defaults kind to end-to-end on existing manifests that omit it', async () => {
    // The V2.ab starter fixtures pre-date the kind field; the loader
    // must keep treating them as end-to-end without a YAML change.
    const f = await loadFixture('node-express-small');
    cleanups.push(f.workspacePath);
    expect(f.manifest.kind).toBe('end-to-end');
    expect(f.manifest.agentKind).toBeUndefined();
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
