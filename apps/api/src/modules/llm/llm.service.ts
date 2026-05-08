import { Injectable } from '@nestjs/common';
import { ProviderRegistry, CapabilityRouter, CircuitBreaker } from '@mergecrew/llm';
import { ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';

@Injectable()
export class LlmService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private crypto: CryptoService,
  ) {}

  async listProviders() {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.findMany({ where: { organizationId: t.organizationId } }),
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      endpoint: r.endpoint,
      hasCredential: r.credentialCiphertext !== null,
      capabilityOverrides: r.capabilityOverrides,
      createdAt: r.createdAt,
    }));
  }

  async createProvider(input: {
    kind: 'anthropic' | 'openai' | 'bedrock' | 'ollama';
    label: string;
    apiKey?: string;
    endpoint?: string;
    capabilityOverrides?: Record<string, unknown>;
  }) {
    const t = this.tenant.require();
    if (!['anthropic', 'openai', 'bedrock', 'ollama'].includes(input.kind))
      throw new ValidationError('unknown provider kind');
    const ciphertext = input.apiKey ? this.crypto.encrypt(input.apiKey) : null;
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.create({
        data: {
          organizationId: t.organizationId,
          kind: input.kind,
          label: input.label,
          endpoint: input.endpoint ?? null,
          credentialCiphertext: ciphertext,
          capabilityOverrides: (input.capabilityOverrides ?? null) as any,
        },
      }),
    );
  }

  async listProfiles() {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProfile.findMany({ where: { organizationId: t.organizationId } }),
    );
  }

  async createProfile(input: {
    name: string;
    preferenceOrder: string[];
    capabilityRouting: Record<string, unknown>;
  }) {
    const t = this.tenant.require();
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProfile.create({
        data: {
          organizationId: t.organizationId,
          name: input.name,
          preferenceOrder: input.preferenceOrder as any,
          capabilityRouting: input.capabilityRouting as any,
        },
      }),
    );
  }

  /**
   * Build a registry + router for the given org. Used by the runner / API
   * "probe" calls. The returned router holds in-memory provider instances —
   * caller is responsible for not retaining beyond a request cycle.
   */
  async buildRouterForOrg(): Promise<{ router: CapabilityRouter; profiles: any[] }> {
    const t = this.tenant.require();
    const providers = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.findMany({ where: { organizationId: t.organizationId } }),
    );
    const configs = providers.map((p) => ({
      id: p.id,
      kind: p.kind as any,
      apiKey: p.credentialCiphertext ? this.crypto.decrypt(p.credentialCiphertext) : '',
      endpoint: p.endpoint ?? undefined,
      models: ((p.capabilityOverrides as any)?.models ?? []) as string[],
      capabilityOverrides: p.capabilityOverrides as Record<string, Record<string, unknown>> | undefined,
    }));
    const registry = new ProviderRegistry(configs);
    const router = new CapabilityRouter(registry, new CircuitBreaker());
    const profiles = await this.listProfiles();
    return { router, profiles };
  }
}
