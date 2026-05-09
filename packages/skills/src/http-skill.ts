import type { CustomSkillDef } from '@mergecrew/domain';
import type { AnySkill } from './types.js';

/**
 * Build a runnable skill from a `CustomSkillDef` declared in `mergecrew.yaml`.
 *
 * Custom skills are HTTP-based: the agent calls them by name, the runner POSTs
 * the input JSON to the configured `endpoint`, and the response body becomes
 * the skill output. This is the seam users extend to integrate their own
 * tools without forking the runner.
 *
 * Skills without an `endpoint` are inert; calling them throws so the failure
 * is loud rather than silently no-op.
 */
export function buildHttpSkill(name: string, def: CustomSkillDef): AnySkill {
  return {
    name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    sideEffectClass: def.sideEffectClass,
    capabilities: ['net.outbound'],
    timeoutMs: 30_000,
    async execute(input: unknown, ctx) {
      if (!def.endpoint) {
        throw new Error(
          `custom skill "${name}" has no endpoint configured in mergecrew.yaml`,
        );
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-mergecrew-org-id': ctx.organizationId,
        'x-mergecrew-project-id': ctx.projectId,
      };
      if (ctx.runId) headers['x-mergecrew-run-id'] = ctx.runId;

      const r = await fetch(def.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
        signal: ctx.abortSignal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(
          `custom skill "${name}" returned HTTP ${r.status}: ${body.slice(0, 500)}`,
        );
      }
      const output: unknown = await r.json().catch(() => ({}));
      return { output, brief: `${name} (HTTP ${r.status})` };
    },
  };
}
