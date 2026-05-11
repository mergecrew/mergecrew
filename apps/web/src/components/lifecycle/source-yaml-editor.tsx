'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { safeParseMergecrewYaml, type YamlIssue } from '@mergecrew/config-yaml';
import { Button } from '@/components/ui';
import type { LifecycleScope } from './scope';

interface Props {
  scope: LifecycleScope;
  initialYaml: string;
  readOnly: boolean;
  onSave: (yaml: string) => Promise<unknown>;
}

/**
 * Editable YAML source view for the lifecycle editor (#270). Validates
 * client-side with the shared safeParseMergecrewYaml so a 200-line file
 * gets per-line error markers without a round-trip to the API. Save
 * stays disabled while issues exist; the server still re-validates as
 * the second wall on save.
 */
export function SourceYamlEditor({ initialYaml, readOnly, onSave }: Props) {
  const [yaml, setYaml] = useState(initialYaml);
  const [debouncedYaml, setDebouncedYaml] = useState(initialYaml);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Debounce parse — 200ms is short enough to feel inline, long enough
  // to skip half the keystrokes in a fast-typing burst.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedYaml(yaml), 200);
    return () => clearTimeout(t);
  }, [yaml]);

  const result = useMemo(() => safeParseMergecrewYaml(debouncedYaml), [debouncedYaml]);
  const issues: YamlIssue[] = result.ok ? [] : result.issues;
  const dirty = yaml !== initialYaml;
  const canSave = !readOnly && dirty && issues.length === 0 && yaml.trim().length > 0;

  // Compute the 0-indexed character offset of the start of `line` (1-indexed).
  const offsetForLine = (line: number): number => {
    if (line <= 1) return 0;
    let offset = 0;
    let current = 1;
    for (let i = 0; i < yaml.length && current < line; i++) {
      if (yaml[i] === '\n') {
        current++;
        if (current === line) {
          offset = i + 1;
          break;
        }
      }
    }
    return offset;
  };

  const jumpToLine = (line: number | null) => {
    if (line == null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const start = offsetForLine(line);
    // Select up to the next newline so the highlight is visible.
    const nextNewline = yaml.indexOf('\n', start);
    const end = nextNewline === -1 ? yaml.length : nextNewline;
    ta.focus();
    ta.setSelectionRange(start, end);
  };

  const submit = () => {
    if (!canSave) return;
    setFeedback(null);
    startTransition(async () => {
      try {
        await onSave(yaml);
        setFeedback({ kind: 'ok', msg: 'Saved. A new lifecycle version was created.' });
      } catch (e: any) {
        setFeedback({ kind: 'err', msg: String(e?.message ?? e) });
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-xs text-zinc-500">
          {readOnly
            ? 'Read-only — your role does not allow editing the lifecycle.'
            : 'Edits validate live. Save creates a new lifecycle version.'}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {dirty && issues.length === 0 && (
              <span className="text-xs text-emerald-700 dark:text-emerald-300">
                Valid · ready to save
              </span>
            )}
            {issues.length > 0 && (
              <span className="text-xs text-rose-700 dark:text-rose-300">
                {issues.length} issue{issues.length === 1 ? '' : 's'}
              </span>
            )}
            <Button variant="primary" disabled={!canSave || pending} onClick={submit}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      <textarea
        ref={textareaRef}
        className="block h-[60vh] w-full overflow-auto rounded border bg-zinc-50 p-3 font-mono text-xs leading-5 dark:border-zinc-800 dark:bg-zinc-900 disabled:opacity-70"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        disabled={readOnly}
      />

      {issues.length > 0 && (
        <div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs dark:border-rose-700/40 dark:bg-rose-950/30">
          <div className="font-medium text-rose-800 dark:text-rose-200">
            {issues.length === 1 ? 'Issue' : 'Issues'} preventing save
          </div>
          <ul className="mt-1 space-y-1">
            {issues.map((iss, i) => (
              <li key={`${iss.kind}-${i}`} className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => jumpToLine(iss.line)}
                  className="shrink-0 rounded border border-rose-400/50 px-1.5 py-0.5 font-mono text-[10px] text-rose-800 hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-900/40 disabled:opacity-50"
                  disabled={iss.line == null}
                  title={iss.line == null ? 'No line information for this issue' : `Jump to line ${iss.line}`}
                >
                  {iss.line == null ? '?' : `L${iss.line}`}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-rose-900 dark:text-rose-100">{iss.message}</div>
                  {iss.path && (
                    <div className="mt-0.5 font-mono text-[10px] text-rose-700/80 dark:text-rose-300/70">
                      at <span className="font-mono">{iss.path}</span>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {feedback && (
        <div
          className={
            'rounded p-2 text-xs ' +
            (feedback.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-900/20 dark:text-rose-300')
          }
        >
          {feedback.msg}
        </div>
      )}
    </div>
  );
}
