import type { PackageJsonVersionChange } from './auto-promote.js';

/**
 * Parse the difference between two package.json texts. Returns the list
 * of version transitions in `dependencies`, `devDependencies`, and
 * `peerDependencies`. The result is structured so the auto-promote
 * matcher can verify each transition is a patch bump (#154).
 *
 * Behavior:
 *  - Returns `null` if the JSON fails to parse, if a sibling field
 *    outside the dep blocks changed (`name`, `scripts`, `engines`, …),
 *    or if a dep was added/removed (no transition to validate).
 *  - Returns an empty array if the dep blocks are byte-identical at the
 *    parsed level — the matcher treats this as "no version changes,
 *    safe by default" iff every changed file is a manifest.
 */
export function parsePackageJsonDiff(
  beforeText: string,
  afterText: string,
): PackageJsonVersionChange[] | null {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return null;
  }
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return null;
  }

  const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies'];
  // Any sibling field that changed (name, scripts, version, engines, etc.)
  // is out of scope — we don't have rules to evaluate those, so the safe
  // call is to refuse the auto-promotion.
  const allKeys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const k of allKeys) {
    if (DEP_KEYS.includes(k)) continue;
    if (!deepEqual(before[k], after[k])) {
      return null;
    }
  }

  const changes: PackageJsonVersionChange[] = [];
  for (const block of DEP_KEYS) {
    const b = (before[block] as Record<string, string> | undefined) ?? {};
    const a = (after[block] as Record<string, string> | undefined) ?? {};
    const names = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
    for (const name of names) {
      const bv = b[name];
      const av = a[name];
      if (bv === undefined || av === undefined) {
        // Add or remove — out of scope for patch-bump validation.
        return null;
      }
      if (bv !== av) {
        changes.push({ name, before: bv, after: av });
      }
    }
  }
  return changes;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
