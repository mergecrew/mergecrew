import { describe, expect, it } from 'vitest';
import {
  autoPromoteMatches,
  type AutoPromoteCandidate,
  type AutoPromoteRule,
} from '../src/auto-promote.js';

const docsRule: AutoPromoteRule = {
  name: 'docs-only',
  pathPatterns: ['**/*.md', '**/*.mdx'],
  requireDocsOnly: true,
  maxFilesChanged: 10,
};

const depPatchRule: AutoPromoteRule = {
  name: 'dep-patch-bump',
  pathPatterns: ['**/package.json', '**/pnpm-lock.yaml'],
  requirePackageJsonPatchOnly: true,
  maxFilesChanged: 5,
};

const contentRule: AutoPromoteRule = {
  name: 'content-update',
  pathPatterns: ['content/**'],
  maxLinesChanged: 200,
};

const file = (
  path: string,
  additions = 1,
  deletions = 0,
): AutoPromoteCandidate['files'][number] => ({ path, additions, deletions });

describe('autoPromoteMatches', () => {
  // ─── docs-only ────────────────────────────────────────────────────────────

  it('matches a docs-only diff', () => {
    expect(
      autoPromoteMatches(docsRule, { files: [file('README.md'), file('docs/getting-started.md')] }),
    ).toEqual({ matched: true });
  });

  it('rejects a docs+code diff under docs-only', () => {
    const r = autoPromoteMatches(docsRule, {
      files: [file('README.md'), file('src/index.ts')],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('src/index.ts');
  });

  it('rejects when too many files changed', () => {
    const r = autoPromoteMatches(
      { ...docsRule, maxFilesChanged: 2 },
      { files: [file('a.md'), file('b.md'), file('c.md')] },
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('3 files');
  });

  it('rejects an empty changeset', () => {
    const r = autoPromoteMatches(docsRule, { files: [] });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('no files');
  });

  // ─── dep patch bumps ──────────────────────────────────────────────────────

  it('matches a clean patch-bump in package.json + lockfile', () => {
    expect(
      autoPromoteMatches(depPatchRule, {
        files: [file('package.json', 2, 2), file('pnpm-lock.yaml', 8, 8)],
        packageJsonChanges: [{ name: 'lodash', before: '4.17.20', after: '4.17.21' }],
      }),
    ).toEqual({ matched: true });
  });

  it('rejects a minor bump under dep-patch rule', () => {
    const r = autoPromoteMatches(depPatchRule, {
      files: [file('package.json', 2, 2)],
      packageJsonChanges: [{ name: 'react', before: '18.2.0', after: '18.3.0' }],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('react');
    expect(r.reason).toContain('not a patch bump');
  });

  it('rejects a major bump under dep-patch rule', () => {
    const r = autoPromoteMatches(depPatchRule, {
      files: [file('package.json')],
      packageJsonChanges: [{ name: 'next', before: '14.0.0', after: '15.0.0' }],
    });
    expect(r.matched).toBe(false);
  });

  it('rejects a non-package file under dep-patch rule', () => {
    const r = autoPromoteMatches(depPatchRule, {
      files: [file('package.json'), file('src/index.ts')],
      packageJsonChanges: [{ name: 'foo', before: '1.0.0', after: '1.0.1' }],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('src/index.ts');
  });

  it('rejects requirePackageJsonPatchOnly when packageJsonChanges is undefined', () => {
    // Safety: a caller that didn't parse versions could otherwise auto-promote
    // a major bump that happens to live in package.json.
    const r = autoPromoteMatches(depPatchRule, {
      files: [file('package.json')],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('parsed packageJsonChanges');
  });

  it('treats caret/tilde prefixes as patch bumps', () => {
    expect(
      autoPromoteMatches(depPatchRule, {
        files: [file('package.json')],
        packageJsonChanges: [{ name: 'foo', before: '^1.2.3', after: '^1.2.5' }],
      }),
    ).toEqual({ matched: true });
  });

  // ─── content updates ──────────────────────────────────────────────────────

  it('matches a small content update', () => {
    expect(
      autoPromoteMatches(contentRule, {
        files: [file('content/blog/2025-01-01.mdx', 50, 0), file('content/authors.json', 1, 1)],
      }),
    ).toEqual({ matched: true });
  });

  it('rejects an oversized content update', () => {
    const r = autoPromoteMatches(contentRule, {
      files: [file('content/giant.mdx', 500, 100)],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('600 lines');
  });

  it('rejects a content rule when a non-content file is included', () => {
    const r = autoPromoteMatches(contentRule, {
      files: [file('content/post.mdx'), file('apps/web/page.tsx')],
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('apps/web/page.tsx');
  });
});
