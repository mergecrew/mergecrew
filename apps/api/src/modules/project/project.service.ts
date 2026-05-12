import { Injectable } from '@nestjs/common';
import {
  AutoPromoteRule,
  NotFoundError,
  ValidationError,
  type AutoPromoteRule as AutoPromoteRuleType,
} from '@mergecrew/domain';
import { GitHubIssuesProvider, type TrackerProvider } from '@mergecrew/adapters-tracker';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';
import { TelemetryService } from '../../common/telemetry.service.js';
import { defaultConfig } from '@mergecrew/config-yaml';

const TRACKER_TOKEN_SECRET = 'TRACKER_TOKEN';
const SUPPORTED_TRACKERS = ['github-issues', 'linear'] as const;
type TrackerAdapterId = (typeof SUPPORTED_TRACKERS)[number];

/** Adapter ids that match the telemetry `integration.connected` provider enum. */
const TELEMETRY_DEPLOY_PROVIDERS = new Set<string>([
  'github-actions',
  'vercel',
  'netlify',
  'aws-direct',
  'fly',
  'render',
  'railway',
]);

const ERROR_TRACKER_TOKEN_SECRET = 'ERROR_TRACKER_TOKEN';
const SUPPORTED_ERROR_TRACKERS = ['sentry'] as const;
type ErrorTrackerAdapterId = (typeof SUPPORTED_ERROR_TRACKERS)[number];

function isPlausibleCron(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  return parts.length === 5 || parts.length === 6;
}

@Injectable()
export class ProjectService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private crypto: CryptoService,
    private telemetry: TelemetryService,
  ) {}

  async list() {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findMany({
        where: { organizationId: t.organizationId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async create(input: { name: string; slug: string }) {
    const t = this.tenant.require();
    const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.create({
        data: {
          organizationId: t.organizationId,
          slug,
          name: input.name,
        },
      }),
    );

    // Seed an initial Lifecycle. If the org has a default template, use it;
    // otherwise fall back to the built-in default config.
    const orgTemplate = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.orgLifecycleTemplate.findFirst({
        where: { organizationId: t.organizationId, name: 'default' },
      }),
    );
    const parsed = orgTemplate ? orgTemplate.parsed : (defaultConfig() as any);
    const sourceYaml = orgTemplate?.sourceYaml ?? '';
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.lifecycle.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          version: 1,
          sourceYaml,
          parsed,
        },
      }),
    );

    // Default schedule.
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.schedule.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          cron: '0 8 * * 1-5',
          timezone: 'UTC',
          enabled: true,
        },
      }),
    );

    // New projects always start paused (#229) — no repo, no deploy
    // target yet. The `paused` field lets us measure onboarding
    // completion rate over time without recording which projects.
    void this.telemetry.emit(t.organizationId, 'project.created', { paused: true });
    return project;
  }

  async detail(slug: string) {
    const t = this.tenant.require();
    const p = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({
        where: { organizationId: t.organizationId, slug, deletedAt: null },
        include: { connectedRepo: true, deployTargets: true },
      }),
    );
    if (!p) throw new NotFoundError();
    return p;
  }

  async getById(id: string) {
    const t = this.tenant.require();
    const p = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!p) throw new NotFoundError();
    return p;
  }

  async update(
    slug: string,
    patch: {
      name?: string;
      description?: string | null;
      archived?: boolean;
      dryRun?: boolean;
      maxFilesChanged?: number;
      maxLinesChanged?: number;
      deniedPaths?: string[];
      autoMergeThreshold?: number;
      sensitivePaths?: string[];
    },
  ) {
    const project = await this.detail(slug);
    const data: {
      name?: string;
      description?: string | null;
      archivedAt?: Date | null;
      dryRun?: boolean;
      maxFilesChanged?: number;
      maxLinesChanged?: number;
      deniedPaths?: any;
      autoMergeThreshold?: number;
      sensitivePaths?: any;
    } = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new ValidationError('name cannot be empty');
      data.name = trimmed;
    }
    if (patch.description !== undefined) {
      data.description = patch.description === null ? null : patch.description.trim() || null;
    }
    if (patch.archived !== undefined) {
      data.archivedAt = patch.archived ? new Date() : null;
    }
    if (patch.dryRun !== undefined) {
      data.dryRun = Boolean(patch.dryRun);
    }
    if (patch.maxFilesChanged !== undefined) {
      if (!Number.isInteger(patch.maxFilesChanged) || patch.maxFilesChanged < 1) {
        throw new ValidationError('maxFilesChanged must be a positive integer');
      }
      data.maxFilesChanged = patch.maxFilesChanged;
    }
    if (patch.maxLinesChanged !== undefined) {
      if (!Number.isInteger(patch.maxLinesChanged) || patch.maxLinesChanged < 1) {
        throw new ValidationError('maxLinesChanged must be a positive integer');
      }
      data.maxLinesChanged = patch.maxLinesChanged;
    }
    if (patch.deniedPaths !== undefined) {
      if (!Array.isArray(patch.deniedPaths) || patch.deniedPaths.some((p) => typeof p !== 'string' || !p.trim())) {
        throw new ValidationError('deniedPaths must be an array of non-empty glob strings');
      }
      data.deniedPaths = patch.deniedPaths.map((p) => p.trim());
    }
    if (patch.autoMergeThreshold !== undefined) {
      if (!Number.isInteger(patch.autoMergeThreshold) || patch.autoMergeThreshold < 0) {
        throw new ValidationError('autoMergeThreshold must be a non-negative integer');
      }
      data.autoMergeThreshold = patch.autoMergeThreshold;
    }
    if (patch.sensitivePaths !== undefined) {
      if (!Array.isArray(patch.sensitivePaths) || patch.sensitivePaths.some((p) => typeof p !== 'string' || !p.trim())) {
        throw new ValidationError('sensitivePaths must be an array of non-empty glob strings');
      }
      data.sensitivePaths = patch.sensitivePaths.map((p) => p.trim());
    }
    return this.prisma.withTenant(project.organizationId, (tx) =>
      tx.project.update({ where: { id: project.id }, data }),
    );
  }

  async connectRepo(slug: string, input: {
    installationId: string;
    repoId: string;
    repoFullName: string;
    defaultBranch: string;
  }) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(input.repoFullName)) {
      throw new ValidationError('repoFullName must be "owner/repo"');
    }
    const project = await this.detail(slug);
    const result = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.connectedRepo.upsert({
        where: { projectId: project.id },
        update: {
          installationId: input.installationId,
          repoId: input.repoId,
          repoFullName: input.repoFullName,
          defaultBranch: input.defaultBranch,
        },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          vcsProvider: 'github',
          installationId: input.installationId,
          repoId: input.repoId,
          repoFullName: input.repoFullName,
          defaultBranch: input.defaultBranch,
        },
      }),
    );
    void this.telemetry.emit(project.organizationId, 'integration.connected', {
      provider: 'github',
    });
    return result;
  }

  async disconnectRepo(slug: string) {
    const project = await this.detail(slug);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.connectedRepo.deleteMany({ where: { projectId: project.id } }),
    );
  }

  /**
   * Returns the repos accessible to the given GitHub App installation
   * (#184). Used by the BFF after a fresh install to populate a repo
   * dropdown so the user doesn't have to retype names. Falls back to an
   * empty list when GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY aren't set —
   * the caller's UI degrades to a free-text input in that case.
   */
  async listInstallationRepos(installationId: string) {
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
      return [];
    }
    if (!installationId || !/^\d+$/.test(installationId)) {
      throw new ValidationError('installationId must be a numeric string');
    }
    // Lazy-import so the API doesn't pull execa-via-adapters-vcs into the
    // module graph until a request actually needs it.
    const { GitHubProvider } = await import('@mergecrew/adapters-vcs');
    const gh = new GitHubProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    });
    return gh.listInstallationRepos(installationId);
  }

  async listDeployTargets(slug: string) {
    const project = await this.detail(slug);
    return this.prisma.withTenant(project.organizationId, (tx) =>
      tx.deployTarget.findMany({ where: { projectId: project.id } }),
    );
  }

  async deleteDeployTarget(slug: string, kind: 'dev' | 'staging' | 'prod') {
    const project = await this.detail(slug);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.deployTarget.deleteMany({ where: { projectId: project.id, kind } }),
    );
  }

  async upsertDeployTarget(slug: string, input: {
    kind: 'dev' | 'staging' | 'prod';
    adapterId: string;
    config: Record<string, unknown>;
  }) {
    const project = await this.detail(slug);
    const result = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.deployTarget.upsert({
        where: { projectId_kind: { projectId: project.id, kind: input.kind } },
        update: { adapterId: input.adapterId, config: input.config as any },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          kind: input.kind,
          adapterId: input.adapterId,
          config: input.config as any,
        },
      }),
    );
    // Telemetry's `provider` enum is the union of every adapter id we
    // ship — see packages/telemetry/src/events.ts. Only emit when the
    // adapterId is in the enum so a future custom adapter doesn't
    // smuggle an undocumented value into the event stream.
    if (TELEMETRY_DEPLOY_PROVIDERS.has(input.adapterId)) {
      void this.telemetry.emit(project.organizationId, 'integration.connected', {
        provider: input.adapterId,
      });
    }
    return result;
  }

  async listSecrets(slug: string) {
    const project = await this.detail(slug);
    const rows = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.findMany({ where: { projectId: project.id } }),
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt }));
  }

  async setSecret(slug: string, name: string, value: string) {
    if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new ValidationError('secret name must be UPPER_SNAKE');
    }
    const project = await this.detail(slug);
    const ciphertext = this.crypto.encrypt(value);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.upsert({
        where: { projectId_name: { projectId: project.id, name } },
        update: { ciphertext },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          name,
          ciphertext,
        },
      }),
    );
  }

  async deleteSecret(slug: string, name: string) {
    const project = await this.detail(slug);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.delete({ where: { projectId_name: { projectId: project.id, name } } }),
    );
  }

  async getSecretPlaintext(projectId: string, name: string): Promise<string | null> {
    const t = this.tenant.require();
    const r = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.projectSecret.findFirst({ where: { projectId, name } }),
    );
    if (!r) return null;
    return this.crypto.decrypt(r.ciphertext);
  }

  async getTracker(slug: string) {
    const project = await this.detail(slug);
    const target = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.trackerTarget.findUnique({ where: { projectId: project.id } }),
    );
    if (!target) return null;
    const tokenSecret = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.findFirst({
        where: { projectId: project.id, name: TRACKER_TOKEN_SECRET },
      }),
    );
    return {
      id: target.id,
      adapterId: target.adapterId,
      config: target.config,
      hasToken: tokenSecret !== null,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }

  async upsertTracker(slug: string, input: {
    adapterId: string;
    config: Record<string, unknown>;
    token?: string;
  }) {
    if (!SUPPORTED_TRACKERS.includes(input.adapterId as TrackerAdapterId)) {
      throw new ValidationError(`unsupported tracker adapter: ${input.adapterId}`);
    }
    if (input.adapterId === 'github-issues') {
      const repo = (input.config?.repoFullName as string | undefined) ?? '';
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        throw new ValidationError('github-issues requires config.repoFullName as "owner/repo"');
      }
    }
    const project = await this.detail(slug);
    const target = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.trackerTarget.upsert({
        where: { projectId: project.id },
        update: { adapterId: input.adapterId, config: input.config as any },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          adapterId: input.adapterId,
          config: input.config as any,
        },
      }),
    );
    if (input.token && input.token.length > 0) {
      await this.setSecret(slug, TRACKER_TOKEN_SECRET, input.token);
    }
    void this.telemetry.emit(project.organizationId, 'integration.connected', {
      provider: input.adapterId,
    });
    return target;
  }

  async deleteTracker(slug: string) {
    const project = await this.detail(slug);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.trackerTarget.deleteMany({ where: { projectId: project.id } }),
    );
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.deleteMany({
        where: { projectId: project.id, name: TRACKER_TOKEN_SECRET },
      }),
    );
  }

  /**
   * Build a TrackerProvider for the project, or return null if not configured.
   * Used by the API's "test connection" endpoint and by the runner at step time.
   */
  async buildTrackerProvider(projectId: string): Promise<TrackerProvider | null> {
    const t = this.tenant.require();
    const target = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.trackerTarget.findUnique({ where: { projectId } }),
    );
    if (!target) return null;
    const token = await this.getSecretPlaintext(projectId, TRACKER_TOKEN_SECRET);
    if (!token) return null;
    if (target.adapterId === 'github-issues') {
      const repoFullName = (target.config as any)?.repoFullName ?? '';
      return new GitHubIssuesProvider({ installationToken: token, repoFullName });
    }
    return null;
  }

  // ── Error tracker (Sentry, etc.) ─────────────────────────────────────────

  async getErrorTarget(slug: string) {
    const project = await this.detail(slug);
    const target = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.errorTarget.findUnique({ where: { projectId: project.id } }),
    );
    if (!target) return null;
    const tokenSecret = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.findFirst({
        where: { projectId: project.id, name: ERROR_TRACKER_TOKEN_SECRET },
      }),
    );
    return {
      id: target.id,
      adapterId: target.adapterId,
      config: target.config,
      hasToken: tokenSecret !== null,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }

  async upsertErrorTarget(slug: string, input: {
    adapterId: string;
    config: Record<string, unknown>;
    token?: string;
  }) {
    if (!SUPPORTED_ERROR_TRACKERS.includes(input.adapterId as ErrorTrackerAdapterId)) {
      throw new ValidationError(`unsupported error tracker adapter: ${input.adapterId}`);
    }
    if (input.adapterId === 'sentry') {
      const org = (input.config?.org as string | undefined) ?? '';
      const proj = (input.config?.project as string | undefined) ?? '';
      if (!org || !proj) {
        throw new ValidationError('sentry requires config.org and config.project slugs');
      }
    }
    const project = await this.detail(slug);
    const target = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.errorTarget.upsert({
        where: { projectId: project.id },
        update: { adapterId: input.adapterId, config: input.config as any },
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          adapterId: input.adapterId,
          config: input.config as any,
        },
      }),
    );
    if (input.token && input.token.length > 0) {
      await this.setSecret(slug, ERROR_TRACKER_TOKEN_SECRET, input.token);
    }
    void this.telemetry.emit(project.organizationId, 'integration.connected', {
      provider: input.adapterId,
    });
    return target;
  }

  async deleteErrorTarget(slug: string) {
    const project = await this.detail(slug);
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.errorTarget.deleteMany({ where: { projectId: project.id } }),
    );
    await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.projectSecret.deleteMany({
        where: { projectId: project.id, name: ERROR_TRACKER_TOKEN_SECRET },
      }),
    );
  }

  /** Resolve {target, token} for runner-side ctx injection, or null if not configured. */
  async getErrorTargetForRunner(projectId: string): Promise<{
    adapterId: string;
    config: Record<string, unknown>;
    token: string;
  } | null> {
    const t = this.tenant.require();
    const target = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.errorTarget.findUnique({ where: { projectId } }),
    );
    if (!target) return null;
    const token = await this.getSecretPlaintext(projectId, ERROR_TRACKER_TOKEN_SECRET);
    if (!token) return null;
    return { adapterId: target.adapterId, config: target.config as any, token };
  }

  async getSchedule(slug: string) {
    const project = await this.detail(slug);
    const schedule = await this.prisma.withTenant(project.organizationId, (tx) =>
      tx.schedule.findUnique({ where: { projectId: project.id } }),
    );
    return schedule;
  }

  async updateSchedule(
    slug: string,
    input: { cron?: string; timezone?: string; enabled?: boolean; skipDates?: string[] },
  ) {
    const project = await this.detail(slug);
    if (input.cron !== undefined && !isPlausibleCron(input.cron)) {
      throw new ValidationError('cron must have 5 or 6 space-separated fields');
    }
    if (input.skipDates !== undefined) {
      if (!Array.isArray(input.skipDates)) {
        throw new ValidationError('skipDates must be an array of YYYY-MM-DD strings');
      }
      for (const d of input.skipDates) {
        if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          throw new ValidationError(`skipDates entry not in YYYY-MM-DD format: ${String(d)}`);
        }
      }
    }
    const data: Record<string, unknown> = {};
    if (input.cron !== undefined) data.cron = input.cron;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.skipDates !== undefined) data.skipDates = input.skipDates;
    return this.prisma.withTenant(project.organizationId, (tx) =>
      tx.schedule.upsert({
        where: { projectId: project.id },
        update: data,
        create: {
          organizationId: project.organizationId,
          projectId: project.id,
          cron: input.cron ?? '0 8 * * 1-5',
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
          skipDates: input.skipDates ?? [],
        },
      }),
    );
  }

  async getAutoPromoteRules(slug: string): Promise<AutoPromoteRuleType[]> {
    const project = await this.detail(slug);
    return ((project as any).autoPromoteRules ?? []) as AutoPromoteRuleType[];
  }

  async setAutoPromoteRules(slug: string, rules: unknown): Promise<AutoPromoteRuleType[]> {
    if (!Array.isArray(rules)) {
      throw new ValidationError('autoPromoteRules must be an array');
    }
    const parsed: AutoPromoteRuleType[] = [];
    for (let i = 0; i < rules.length; i++) {
      const r = AutoPromoteRule.safeParse(rules[i]);
      if (!r.success) {
        throw new ValidationError(`rule[${i}]: ${r.error.issues[0]?.message ?? 'invalid'}`);
      }
      parsed.push(r.data);
    }
    const seen = new Set<string>();
    for (const r of parsed) {
      if (seen.has(r.name)) throw new ValidationError(`duplicate rule name "${r.name}"`);
      seen.add(r.name);
    }
    const project = await this.detail(slug);
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.update({
        where: { id: project.id },
        data: { autoPromoteRules: parsed as any },
      }),
    );
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'project.autoPromoteRules.updated',
          target: { projectId: project.id },
          metadata: { ruleCount: parsed.length, names: parsed.map((r) => r.name) },
        },
      }),
    );
    return parsed;
  }

  async testTracker(slug: string): Promise<{ ok: boolean; sample?: unknown; error?: string }> {
    const project = await this.detail(slug);
    try {
      const provider = await this.buildTrackerProvider(project.id);
      if (!provider) return { ok: false, error: 'Tracker not fully configured (missing target or token).' };
      const issues = await provider.listIssues({ max: 3 });
      return {
        ok: true,
        sample: issues.map((i) => ({ id: i.id, title: i.title, status: i.status, url: i.url })),
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
}
