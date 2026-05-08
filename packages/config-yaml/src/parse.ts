import YAML from 'yaml';
import { MergecrewConfig, ValidationError } from '@mergecrew/domain';

export interface ParsedConfig {
  source: string;
  parsed: MergecrewConfig;
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
