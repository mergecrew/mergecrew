import { Injectable } from '@nestjs/common';
import {
  parseMergecrewYaml,
  stringifyMergecrewConfig,
  defaultConfig,
  DEFAULT_MERGECREW_YAML,
  mergeWithDefault,
} from '@mergecrew/config-yaml';
import {
  AgentDefinition,
  CustomSkillDef,
  MergecrewConfig,
  HumanGatesDef,
  NotFoundError,
  ValidationError,
  WorkflowDef,
  findStockLifecycleTemplate,
} from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

@Injectable()
export class LifecycleService {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  async current(projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const lc = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } }),
    );
    if (!lc) {
      const created = await this.prisma.withTenant(t.organizationId, (tx) =>
        tx.lifecycle.create({
          data: {
            organizationId: t.organizationId,
            projectId: project.id,
            version: 1,
            sourceYaml: DEFAULT_MERGECREW_YAML,
            parsed: defaultConfig() as any,
          },
        }),
      );
      return created;
    }
    return lc;
  }

  async versions(projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' } }),
    );
  }

  async upsertFromYaml(projectSlug: string, yaml: string) {
    const { parsed } = parseMergecrewYaml(yaml);
    const merged = mergeWithDefault(parsed);
    return this.writeNewVersion(projectSlug, merged, yaml);
  }

  /** Apply an org-level template as a new version of the project's lifecycle. */
  async applyOrgTemplate(projectSlug: string, templateName = 'default') {
    const t = this.tenant.require();
    const tpl = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.findFirst({
        where: { organizationId: t.organizationId, name: templateName },
      }),
    );
    if (!tpl) throw new NotFoundError(`org template "${templateName}" not found`);
    return this.writeNewVersion(projectSlug, tpl.parsed as any, tpl.sourceYaml, templateName);
  }

  /**
   * Apply a stock lifecycle template by id (#480). Stamps the template
   * id as the new version's `name` so the audit chain reads cleanly:
   * v1 `default-bootstrap` → v2 `generic-careful` → v3 hand-edited
   * (null name). Centralizing this on the server replaces the prior
   * "web fetches template then PUTs the YAML" round-trip.
   */
  async applyStockTemplate(projectSlug: string, templateId: string) {
    const tpl = findStockLifecycleTemplate(templateId);
    if (!tpl) throw new NotFoundError(`unknown stock lifecycle template: ${templateId}`);
    return this.writeNewVersion(projectSlug, tpl.parsed as any, tpl.sourceYaml, tpl.id);
  }

  /** Replace an agent definition (insert if missing). */
  async upsertAgent(projectSlug: string, ref: string, def: unknown) {
    return this.mutate(projectSlug, (cfg) => {
      const parsed = AgentDefinition.parse(def);
      cfg.agents = { ...(cfg.agents ?? {}), [ref]: parsed };
    });
  }

  async deleteAgent(projectSlug: string, ref: string) {
    return this.mutate(projectSlug, (cfg) => {
      const next = { ...(cfg.agents ?? {}) };
      delete next[ref];
      cfg.agents = next;
      // Also remove the agent from any workflow.agents arrays.
      cfg.lifecycle.workflows = cfg.lifecycle.workflows.map((w: any) => ({
        ...w,
        agents: (w.agents ?? []).filter((a: string) => a !== ref),
      }));
    });
  }

  async upsertWorkflow(projectSlug: string, id: string, def: unknown) {
    return this.mutate(projectSlug, (cfg) => {
      const parsed = WorkflowDef.parse({ ...(def as any), id });
      const wfs = cfg.lifecycle.workflows ?? [];
      const idx = wfs.findIndex((w: any) => w.id === id);
      if (idx >= 0) wfs[idx] = parsed;
      else wfs.push(parsed);
      cfg.lifecycle.workflows = wfs;
    });
  }

  async deleteWorkflow(projectSlug: string, id: string) {
    return this.mutate(projectSlug, (cfg) => {
      cfg.lifecycle.workflows = (cfg.lifecycle.workflows ?? []).filter((w: any) => w.id !== id);
      // Strip any references to this workflow id from `out` and `transitions.to` of the rest.
      cfg.lifecycle.workflows = cfg.lifecycle.workflows.map((w: any) => ({
        ...w,
        out: (w.out ?? []).filter((x: string) => x !== id),
        transitions: (w.transitions ?? []).filter((tr: any) => tr.to !== id),
      }));
    });
  }

  async upsertCustomSkill(projectSlug: string, name: string, def: unknown) {
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) {
      throw new ValidationError('skill name must be dotted lowercase (e.g. "tracker.list_issues")');
    }
    return this.mutate(projectSlug, (cfg) => {
      const parsed = CustomSkillDef.parse(def);
      cfg.skills = { ...(cfg.skills ?? {}), [name]: parsed };
    });
  }

  async deleteCustomSkill(projectSlug: string, name: string) {
    return this.mutate(projectSlug, (cfg) => {
      const next = { ...(cfg.skills ?? {}) };
      delete next[name];
      cfg.skills = next;
    });
  }

  async setHumanGates(projectSlug: string, gates: unknown) {
    return this.mutate(projectSlug, (cfg) => {
      cfg.lifecycle.human_gates = HumanGatesDef.parse(gates);
    });
  }

  // ---- helpers ----

  private async mutate(projectSlug: string, fn: (cfg: MergecrewConfig) => void) {
    const lc = await this.current(projectSlug);
    const cfg = MergecrewConfig.parse(lc.parsed);
    fn(cfg);
    return this.writeNewVersion(projectSlug, cfg);
  }

  /**
   * Get persisted node positions for the visual lifecycle editor
   * (V2.1 phase 2, #195). Returns a map of `workflowId → { x, y }`.
   * Empty when no positions are saved — the caller renders the
   * BFS-by-depth fallback layout.
   */
  async getGraphLayout(
    projectSlug: string,
  ): Promise<Record<string, { x: number; y: number }>> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycleGraphLayout.findMany({ where: { projectId: project.id } }),
    );
    const out: Record<string, { x: number; y: number }> = {};
    for (const r of rows) out[r.workflowId] = { x: r.x, y: r.y };
    return out;
  }

  /**
   * Persist node positions for the visual lifecycle editor (V2.1
   * phase 2, #195). The body is the full set of positions for the
   * project; we upsert every supplied position and delete any saved
   * row whose workflowId isn't in the body, so removing a workflow
   * from the YAML cleans up its layout in the same transaction.
   */
  async setGraphLayout(
    projectSlug: string,
    positions: Record<string, { x: number; y: number }>,
  ): Promise<{ count: number }> {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();

    const entries = Object.entries(positions ?? {});
    for (const [, pos] of entries) {
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
        throw new ValidationError('positions must be { workflowId: { x: number, y: number } }');
      }
    }
    const ids = entries.map(([id]) => id);

    // `withTenant` already runs us inside a Prisma transaction with the
    // tenant `org_id` set for RLS — no nested $transaction needed.
    await this.prisma.withTenant(t.organizationId, async (tx) => {
      await tx.lifecycleGraphLayout.deleteMany({
        where: {
          projectId: project.id,
          ...(ids.length > 0 ? { workflowId: { notIn: ids } } : {}),
        },
      });
      for (const [workflowId, pos] of entries) {
        await tx.lifecycleGraphLayout.upsert({
          where: { projectId_workflowId: { projectId: project.id, workflowId } },
          update: { x: Math.round(pos.x), y: Math.round(pos.y) },
          create: {
            organizationId: t.organizationId,
            projectId: project.id,
            workflowId,
            x: Math.round(pos.x),
            y: Math.round(pos.y),
          },
        });
      }
    });
    return { count: entries.length };
  }

  private async writeNewVersion(
    projectSlug: string,
    parsed: MergecrewConfig,
    sourceYaml?: string,
    name?: string,
  ) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const last = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } }),
    );
    const version = (last?.version ?? 0) + 1;
    const yaml = sourceYaml ?? stringifyMergecrewConfig(parsed);
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          version,
          sourceYaml: yaml,
          parsed: parsed as any,
          name: name ?? null,
        },
      }),
    );
  }
}
