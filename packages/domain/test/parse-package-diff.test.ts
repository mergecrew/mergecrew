import { describe, expect, it } from 'vitest';
import { parsePackageJsonDiff } from '../src/parse-package-diff.js';

const baseBefore = JSON.stringify(
  {
    name: 'thing',
    version: '1.0.0',
    dependencies: { lodash: '4.17.20' },
    devDependencies: { vitest: '^2.0.0' },
  },
  null,
  2,
);

describe('parsePackageJsonDiff', () => {
  it('detects a single dep version change', () => {
    const after = JSON.stringify(
      {
        name: 'thing',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
        devDependencies: { vitest: '^2.0.0' },
      },
      null,
      2,
    );
    expect(parsePackageJsonDiff(baseBefore, after)).toEqual([
      { name: 'lodash', before: '4.17.20', after: '4.17.21' },
    ]);
  });

  it('returns empty when the dep blocks are unchanged', () => {
    expect(parsePackageJsonDiff(baseBefore, baseBefore)).toEqual([]);
  });

  it('returns null when a sibling field changed', () => {
    const after = JSON.stringify(
      {
        name: 'thing',
        version: '1.0.0',
        scripts: { build: 'tsc' }, // new sibling field
        dependencies: { lodash: '4.17.20' },
        devDependencies: { vitest: '^2.0.0' },
      },
      null,
      2,
    );
    expect(parsePackageJsonDiff(baseBefore, after)).toBeNull();
  });

  it('returns null when a dep is added', () => {
    const after = JSON.stringify(
      {
        name: 'thing',
        version: '1.0.0',
        dependencies: { lodash: '4.17.20', chalk: '5.0.0' },
        devDependencies: { vitest: '^2.0.0' },
      },
      null,
      2,
    );
    expect(parsePackageJsonDiff(baseBefore, after)).toBeNull();
  });

  it('returns null when a dep is removed', () => {
    const after = JSON.stringify(
      {
        name: 'thing',
        version: '1.0.0',
        dependencies: {},
        devDependencies: { vitest: '^2.0.0' },
      },
      null,
      2,
    );
    expect(parsePackageJsonDiff(baseBefore, after)).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(parsePackageJsonDiff('not json', baseBefore)).toBeNull();
    expect(parsePackageJsonDiff(baseBefore, '{ "broken": }')).toBeNull();
  });

  it('does not get tripped by reformats (whitespace) in the dep blocks', () => {
    // Same dep, different formatting — should produce no version change.
    const after = JSON.stringify({
      name: 'thing',
      version: '1.0.0',
      dependencies: { lodash: '4.17.20' },
      devDependencies: { vitest: '^2.0.0' },
    });
    expect(parsePackageJsonDiff(baseBefore, after)).toEqual([]);
  });

  it('detects changes in devDependencies and peerDependencies', () => {
    const before = JSON.stringify({
      name: 'thing',
      version: '1.0.0',
      devDependencies: { vitest: '2.0.0' },
      peerDependencies: { react: '18.2.0' },
    });
    const after = JSON.stringify({
      name: 'thing',
      version: '1.0.0',
      devDependencies: { vitest: '2.0.1' },
      peerDependencies: { react: '18.2.1' },
    });
    expect(parsePackageJsonDiff(before, after)).toEqual([
      { name: 'vitest', before: '2.0.0', after: '2.0.1' },
      { name: 'react', before: '18.2.0', after: '18.2.1' },
    ]);
  });

  it('returns null when the package version field changed', () => {
    const after = JSON.stringify({
      name: 'thing',
      version: '1.0.1', // sibling change
      dependencies: { lodash: '4.17.20' },
      devDependencies: { vitest: '^2.0.0' },
    });
    expect(parsePackageJsonDiff(baseBefore, after)).toBeNull();
  });
});
