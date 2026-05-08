import { Injectable } from '@nestjs/common';
import { parseMergecrewYaml, stringifyMergecrewConfig, defaultConfig, DEFAULT_MERGECREW_YAML } from '@mergecrew/config-yaml';
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
export class OrgTemplateService {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  async list() {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async get(name = 'default') {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.findFirst({
        where: { organizationId: t.organizationId, name },
      }),
    );
  }

  async ensureDefault() {
    const existing = await this.get('default');
    if (existing) return existing;
    return this.upsertFromConfig('default', defaultConfig());
  }

  async upsertFromYaml(name: string, yaml: string) {
    const { parsed } = parseMergecrewYaml(yaml);
    return this.persist(name, yaml, parsed);
  }

  async upsertFromConfig(name: string, config: MergecrewConfig) {
    const yaml = stringifyMergecrewConfig(config);
    return this.persist(name, yaml, config);
  }

  async upsertAgent(name: string, ref: string, def: unknown) {
    return this.mutate(name, (cfg) => {
      const parsed = AgentDefinition.parse(def);
      cfg.agents = { ...(cfg.agents ?? {}), [ref]: parsed };
    });
  }

  async deleteAgent(name: string, ref: string) {
    return this.mutate(name, (cfg) => {
      const next = { ...(cfg.agents ?? {}) };
      delete next[ref];
      cfg.agents = next;
      cfg.lifecycle.workflows = cfg.lifecycle.workflows.map((w: any) => ({
        ...w,
        agents: (w.agents ?? []).filter((a: string) => a !== ref),
      }));
    });
  }

  async upsertWorkflow(name: string, id: string, def: unknown) {
    return this.mutate(name, (cfg) => {
      const parsed = WorkflowDef.parse({ ...(def as any), id });
      const wfs = cfg.lifecycle.workflows ?? [];
      const idx = wfs.findIndex((w: any) => w.id === id);
      if (idx >= 0) wfs[idx] = parsed;
      else wfs.push(parsed);
      cfg.lifecycle.workflows = wfs;
    });
  }

  async deleteWorkflow(name: string, id: string) {
    return this.mutate(name, (cfg) => {
      cfg.lifecycle.workflows = (cfg.lifecycle.workflows ?? [])
        .filter((w: any) => w.id !== id)
        .map((w: any) => ({
          ...w,
          out: (w.out ?? []).filter((x: string) => x !== id),
          transitions: (w.transitions ?? []).filter((tr: any) => tr.to !== id),
        }));
    });
  }

  async upsertCustomSkill(name: string, skillName: string, def: unknown) {
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(skillName)) {
      throw new ValidationError('skill name must be dotted lowercase (e.g. "tracker.list_issues")');
    }
    return this.mutate(name, (cfg) => {
      const parsed = CustomSkillDef.parse(def);
      cfg.skills = { ...(cfg.skills ?? {}), [skillName]: parsed };
    });
  }

  async deleteCustomSkill(name: string, skillName: string) {
    return this.mutate(name, (cfg) => {
      const next = { ...(cfg.skills ?? {}) };
      delete next[skillName];
      cfg.skills = next;
    });
  }

  async setHumanGates(name: string, gates: unknown) {
    return this.mutate(name, (cfg) => {
      cfg.lifecycle.human_gates = HumanGatesDef.parse(gates);
    });
  }

  async delete(name: string) {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.deleteMany({
        where: { organizationId: t.organizationId, name },
      }),
    );
  }

  // ---- helpers ----

  private async mutate(name: string, fn: (cfg: MergecrewConfig) => void) {
    const tpl = await this.get(name);
    const cfg = tpl
      ? MergecrewConfig.parse(tpl.parsed)
      : MergecrewConfig.parse(defaultConfig());
    fn(cfg);
    return this.upsertFromConfig(name, cfg);
  }

  private async persist(name: string, yaml: string, parsed: MergecrewConfig) {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.upsert({
        where: { organizationId_name: { organizationId: t.organizationId, name } },
        update: { sourceYaml: yaml, parsed: parsed as any },
        create: {
          organizationId: t.organizationId,
          name,
          sourceYaml: yaml,
          parsed: parsed as any,
        },
      }),
    );
  }
}
