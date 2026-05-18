import { DEFAULT_MERGECREW_YAML, type MergecrewConfig } from '@mergecrew/domain';
import { parseMergecrewYaml } from './parse.js';

/**
 * Re-export of the canonical lifecycle YAML. The string itself lives
 * in `@mergecrew/domain/default-mergecrew-yaml.ts` so the
 * lifecycle-templates catalog can use it without inducing a circular
 * dep on config-yaml's parser. Re-exported here for backward compat
 * with the existing `@mergecrew/config-yaml` import paths (notably
 * `packages/inception/src/draft-yaml.ts`).
 */
export { DEFAULT_MERGECREW_YAML };

let _cached: MergecrewConfig | null = null;

export function defaultConfig(): MergecrewConfig {
  if (!_cached) {
    _cached = parseMergecrewYaml(DEFAULT_MERGECREW_YAML).parsed;
  }
  // Defensive deep-clone so callers can mutate without poisoning the cache.
  return JSON.parse(JSON.stringify(_cached));
}
