import YAML, { LineCounter } from 'yaml';
import { MergecrewConfig, ValidationError } from '@mergecrew/domain';

export interface ParsedConfig {
  source: string;
  parsed: MergecrewConfig;
}

export interface YamlIssue {
  /** Human-readable problem description. */
  message: string;
  /** 1-indexed line number in the source. Null when the issue is not location-bound. */
  line: number | null;
  /** Dot-separated path into the parsed shape, e.g. "agents.discovery.kind". Empty for YAML-parse errors. */
  path: string;
  kind: 'yaml' | 'schema';
}

export type SafeParseResult =
  | { ok: true; parsed: MergecrewConfig }
  | { ok: false; issues: YamlIssue[] };

/**
 * Non-throwing variant of {@link parseMergecrewYaml}. Returns a flat list
 * of issues with line numbers so the web editor can surface inline
 * markers (#270). Schema issues without a YAML location resolve to the
 * line where the matching node lives in the source; if that resolution
 * fails the issue's `line` is null.
 */
export function safeParseMergecrewYaml(source: string): SafeParseResult {
  const lc = new LineCounter();
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(source, { lineCounter: lc });
  } catch (e: any) {
    return {
      ok: false,
      issues: [{ message: String(e?.message ?? e), line: null, path: '', kind: 'yaml' }],
    };
  }
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((err) => ({
        message: err.message,
        line: err.linePos?.[0]?.line ?? null,
        path: '',
        kind: 'yaml' as const,
      })),
    };
  }

  const raw = doc.toJS();
  const result = MergecrewConfig.safeParse(raw);
  if (result.success) return { ok: true, parsed: result.data };

  const issues: YamlIssue[] = result.error.issues.map((iss) => {
    const path = iss.path.map((p) => String(p)).join('.');
    let line: number | null = null;
    try {
      const node = doc.getIn(iss.path, true) as { range?: [number, number, number] } | undefined;
      if (node?.range) line = lc.linePos(node.range[0]).line;
    } catch {
      /* fall through with null */
    }
    return { message: iss.message, line, path, kind: 'schema' };
  });
  return { ok: false, issues };
}

export function parseMergecrewYaml(source: string): ParsedConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (e: any) {
    throw new ValidationError(`mergecrew.yaml: invalid YAML: ${e?.message ?? e}`);
  }
  const result = MergecrewConfig.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('mergecrew.yaml: schema invalid', {
      issues: result.error.issues,
    });
  }
  return { source, parsed: result.data };
}

/** Validate + serialize a MergecrewConfig back to YAML. Used by the structured editors. */
export function stringifyMergecrewConfig(config: unknown): string {
  const result = MergecrewConfig.safeParse(config);
  if (!result.success) {
    throw new ValidationError('mergecrew config: schema invalid', {
      issues: result.error.issues,
    });
  }
  return YAML.stringify(result.data, { lineWidth: 0 });
}
