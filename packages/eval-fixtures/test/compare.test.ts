import { describe, expect, it } from 'vitest';
import { compareSnapshot, parseDiff } from '../src/compare.js';

const tolerances = { ignoreLocalRenames: false, ignoreWhitespaceOnly: false };

describe('parseDiff', () => {
  it('extracts added/removed lines per file', () => {
    const raw = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 unchanged
-const a = 1;
+const a = 2;
 unchanged
`;
    const parsed = parseDiff(raw);
    expect(parsed['src/foo.ts']?.removed).toEqual(['const a = 1;']);
    expect(parsed['src/foo.ts']?.added).toEqual(['const a = 2;']);
  });

  it('strips triple-backtick fences', () => {
    const raw = '```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```';
    const parsed = parseDiff(raw);
    expect(parsed['x']?.added).toEqual(['new']);
    expect(parsed['x']?.removed).toEqual(['old']);
  });

  it('handles /dev/null source (new file creation)', () => {
    const raw = `--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+console.log('hi');
`;
    const parsed = parseDiff(raw);
    expect(parsed['src/new.ts']?.added).toEqual(["console.log('hi');"]);
  });
});

describe('compareSnapshot', () => {
  const expected = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

  it('exact match passes', () => {
    const r = compareSnapshot(expected, expected, tolerances);
    expect(r.pass).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('detects a missing required file', () => {
    const agentDiff = `--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-x
+y
`;
    const r = compareSnapshot(agentDiff, expected, tolerances);
    expect(r.pass).toBe(false);
    expect(r.mismatches.some((m) => m.kind === 'missing_required_file' && m.path === 'src/foo.ts')).toBe(true);
  });

  it('flags an unexpected file the agent invented', () => {
    const agentDiff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
--- a/scratch.txt
+++ b/scratch.txt
@@ -0,0 +1,1 @@
+notes
`;
    const r = compareSnapshot(agentDiff, expected, tolerances);
    expect(r.pass).toBe(false);
    expect(r.mismatches.some((m) => m.kind === 'unexpected_file' && m.path === 'scratch.txt')).toBe(true);
  });

  it('local-rename tolerance: identifier-only differences pass when enabled', () => {
    const agentDiff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-const a = 1;
+const renamed = 2;
`;
    const off = compareSnapshot(agentDiff, expected, tolerances);
    expect(off.pass).toBe(false);
    const on = compareSnapshot(agentDiff, expected, { ...tolerances, ignoreLocalRenames: true });
    expect(on.pass).toBe(true);
  });

  it('whitespace tolerance: pure indentation diffs pass when enabled', () => {
    const expectedWs = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-  const a = 1;
+  const a = 2;
`;
    const agentDiff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-    const a = 1;
+    const a = 2;
`;
    const off = compareSnapshot(agentDiff, expectedWs, tolerances);
    expect(off.pass).toBe(false);
    const on = compareSnapshot(agentDiff, expectedWs, { ...tolerances, ignoreWhitespaceOnly: true });
    expect(on.pass).toBe(true);
  });

  it('flags low overlap when agent touched the right file but did the wrong thing', () => {
    const agentDiff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-const a = 1;
+const a = 999;
`;
    const r = compareSnapshot(agentDiff, expected, tolerances);
    expect(r.pass).toBe(false);
    expect(r.mismatches.some((m) => m.kind === 'low_overlap' && m.path === 'src/foo.ts')).toBe(true);
  });

  it('respects an explicit requiredFiles list', () => {
    const r = compareSnapshot(expected, expected, { ...tolerances, requiredFiles: ['src/foo.ts'] });
    expect(r.pass).toBe(true);
  });

  it('disables the required-files check when requiredFiles=[]', () => {
    const agentDiff = `--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-x
+y
`;
    const r = compareSnapshot(agentDiff, expected, { ...tolerances, requiredFiles: [] });
    // src/foo.ts still flagged as untouched_expected_file, src/other.ts as unexpected.
    expect(r.mismatches.some((m) => m.kind === 'missing_required_file')).toBe(false);
    expect(r.mismatches.some((m) => m.kind === 'untouched_expected_file')).toBe(true);
  });
});
