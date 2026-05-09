import type { DiffHunk, DiffLine } from './types.js';

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified-diff patch (the `patch` field GitHub returns per file)
 * into structured hunks with per-line oldLine / newLine numbers.
 *
 * Returns an empty array for empty / binary patches. Pure — no I/O.
 */
export function parseUnifiedPatch(patch: string | null | undefined): DiffHunk[] {
  if (!patch) return [];
  const out: DiffHunk[] = [];
  const lines = patch.split('\n');

  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (current) out.push(current);
      const oldStart = Number(m[1]);
      const oldLines = m[2] ? Number(m[2]) : 1;
      const newStart = Number(m[3]);
      const newLines = m[4] ? Number(m[4]) : 1;
      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: m[5]?.trim() ?? '',
        lines: [],
      };
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }
    if (!current) continue;

    // Skip the no-newline-at-eof marker line; it doesn't represent content.
    if (line.startsWith('\\ No newline')) continue;

    const first = line.charAt(0);
    let entry: DiffLine;
    if (first === '+') {
      entry = { type: 'add', oldLine: null, newLine: newCursor++, content: line.slice(1) };
    } else if (first === '-') {
      entry = { type: 'del', oldLine: oldCursor++, newLine: null, content: line.slice(1) };
    } else if (first === ' ') {
      entry = { type: 'context', oldLine: oldCursor++, newLine: newCursor++, content: line.slice(1) };
    } else {
      // Unknown prefix (could be EOL artifact). Treat as context with the
      // raw content so the renderer doesn't drop visible characters.
      entry = { type: 'context', oldLine: oldCursor++, newLine: newCursor++, content: line };
    }
    current.lines.push(entry);
  }
  if (current) out.push(current);
  return out;
}
