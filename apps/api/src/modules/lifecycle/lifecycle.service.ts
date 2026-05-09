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
    return this.writeNewVersion(projectSlug, tpl.parsed as any, tpl.sourceYaml);
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

  private async writeNewVersion(
    projectSlug: string,
    parsed: MergecrewConfig,
    sourceYaml?: string,
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
        },
      }),
    );
  }
}
