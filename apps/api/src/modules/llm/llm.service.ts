import { Injectable } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import {
  ProviderRegistry,
  CapabilityRouter,
  CircuitBreaker,
  chat,
  probeOllama,
  capabilitiesFor,
} from '@mergecrew/llm';
import type { ModelCapability } from '@mergecrew/domain';
import { NotFoundError, ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';

function defaultProbeModel(kind: string): string | undefined {
  // Cheap, widely-available models for connectivity checks. Customers can
  // still override via the request body if these aren't available on
  // their account.
  if (kind === 'anthropic') return 'claude-3-5-haiku-20241022';
  if (kind === 'openai') return 'gpt-4o-mini';
  if (kind === 'bedrock') return 'anthropic.claude-3-haiku-20240307-v1:0';
  if (kind === 'ollama') return 'qwen3:4b';
  return undefined;
}

// Initial model list seeded into `capabilityOverrides.models` when an
// admin creates a hosted-API provider without declaring any models. Both
// entries match the catalog prefixes in `packages/llm/src/models.ts` so
// `capabilitiesFor()` returns `{ tools: true, longContext: 200_000 }` —
// the capability profile the runner's planner/coder/reviewer require.
//
// Ollama is excluded because `createProvider` already auto-probes the
// endpoint and discovers the real list of pulled models.
function defaultModelsForKind(kind: string): string[] {
  if (kind === 'anthropic') return ['claude-sonnet-4-5', 'claude-haiku-4-5'];
  if (kind === 'openai') return ['gpt-4o', 'gpt-4o-mini'];
  if (kind === 'bedrock')
    return [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
    ];
  return [];
}

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
      // Per-model capability map. The UI uses this to render a vision chip
      // (and could surface other flags later) without re-deriving from
      // model id strings client-side.
      modelCapabilities: capabilityMapFor(r),
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
    let overrides = (input.capabilityOverrides ?? null) as Record<string, unknown> | null;

    // Auto-populate models when admin didn't provide any. Explicit user
    // input always wins. For Ollama we probe the live endpoint; for the
    // hosted APIs (OpenAI/Anthropic/Bedrock) there is no discovery
    // endpoint we can call, so we fall back to a known-good default
    // list so the very first run after "added my API key" doesn't fail
    // with `no provider satisfies capability …`. Operators can prune
    // the list afterwards via the providers UI.
    const declaredModels = (overrides as { models?: unknown } | null)?.models;
    const hasModels = Array.isArray(declaredModels) && declaredModels.length > 0;
    if (!hasModels) {
      if (input.kind === 'ollama' && input.endpoint) {
        const r = await probeOllama(input.endpoint);
        if (r.ok && r.models.length > 0) {
          overrides = { ...(overrides ?? {}), models: r.models };
        }
      } else if (input.kind !== 'ollama') {
        const defaults = defaultModelsForKind(input.kind);
        if (defaults.length > 0) overrides = { ...(overrides ?? {}), models: defaults };
      }
    }

    const created = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.create({
        data: {
          organizationId: t.organizationId,
          kind: input.kind,
          label: input.label,
          endpoint: input.endpoint ?? null,
          credentialCiphertext: ciphertext,
          capabilityOverrides: overrides as any,
        },
      }),
    );

    // Seed a default LlmProfile on first provider so the runner has
    // somewhere to look. Without this, `profiles[0]` in
    // apps/runner/src/step.ts falls through to an empty `preferenceOrder`
    // and the router throws `no provider satisfies capability` even
    // though a valid provider+model exists. We only auto-create when the
    // org has zero profiles — once a profile exists (auto or hand-rolled),
    // the admin owns it.
    const providerModels = ((overrides as { models?: unknown } | null)?.models ?? []) as string[];
    if (providerModels.length > 0) {
      const existingProfileCount = await this.prisma.withTenant(t.organizationId, (tx) =>
        tx.llmProfile.count({ where: { organizationId: t.organizationId } }),
      );
      if (existingProfileCount === 0) {
        await this.prisma.withTenant(t.organizationId, (tx) =>
          tx.llmProfile.create({
            data: {
              organizationId: t.organizationId,
              name: 'default',
              preferenceOrder: providerModels.map((m) => `${created.id}/${m}`) as any,
              capabilityRouting: {} as any,
            },
          }),
        );
      }
    }

    return created;
  }

  async updateProvider(
    id: string,
    input: {
      label?: string;
      endpoint?: string | null;
      apiKey?: string | null;
      capabilityOverrides?: Record<string, unknown> | null;
    },
  ) {
    const t = this.tenant.require();
    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.endpoint !== undefined) data.endpoint = input.endpoint;
    if (input.apiKey !== undefined) {
      data.credentialCiphertext = input.apiKey === null ? null : this.crypto.encrypt(input.apiKey);
    }
    if (input.capabilityOverrides !== undefined) {
      data.capabilityOverrides = input.capabilityOverrides as any;
    }
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.update({ where: { id }, data }),
    );
  }

  async deleteProvider(id: string) {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.delete({ where: { id } }),
    );
  }

  /**
   * Probe an Ollama provider's endpoint and persist the discovered models
   * into `capabilityOverrides.models`. Existing override fields besides
   * `models` are preserved. Non-ollama providers and providers without an
   * endpoint return an error rather than silently doing nothing.
   */
  async probeProvider(
    id: string,
  ): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    const t = this.tenant.require();
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!row) throw new NotFoundError();
    if (row.kind !== 'ollama') {
      return { ok: false, error: `probe is only supported for ollama providers (got ${row.kind})` };
    }
    if (!row.endpoint) {
      return { ok: false, error: 'provider has no endpoint configured' };
    }
    const r = await probeOllama(row.endpoint);
    if (!r.ok) return { ok: false, error: r.error };

    const existing = (row.capabilityOverrides as Record<string, unknown> | null) ?? {};
    const merged = { ...existing, models: r.models };
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.update({
        where: { id },
        data: { capabilityOverrides: merged as any },
      }),
    );
    return { ok: true, models: r.models };
  }

  /**
   * One-shot probe of a provider: build the model, send "ping", measure
   * the round-trip. 5s ceiling. Returns a small, UI-displayable shape.
   * The optional `modelId` overrides the first declared model on the
   * provider (useful when models[] is not populated).
   */
  async testProvider(
    id: string,
    opts: { modelId?: string } = {},
  ): Promise<
    | { ok: true; modelId: string; latencyMs: number; reply: string }
    | { ok: false; error: string }
  > {
    const t = this.tenant.require();
    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProvider.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!row) throw new NotFoundError();

    const declared = ((row.capabilityOverrides as any)?.models ?? []) as string[];
    const modelId = opts.modelId ?? declared[0] ?? defaultProbeModel(row.kind);
    if (!modelId) {
      return {
        ok: false,
        error: 'No model id declared on the provider and no default available for this kind.',
      };
    }

    const registry = new ProviderRegistry([
      {
        id: row.id,
        kind: row.kind as any,
        apiKey: row.credentialCiphertext ? this.crypto.decrypt(row.credentialCiphertext) : '',
        endpoint: row.endpoint ?? undefined,
        awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
        models: declared,
      },
    ]);

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 5_000);
    try {
      const r = await chat({
        registry,
        providerId: row.id,
        modelId,
        messages: [new HumanMessage('ping')],
        signal: ac.signal,
        maxTokens: 16,
        temperature: 0,
      });
      return {
        ok: true,
        modelId,
        latencyMs: r.latencyMs,
        reply: r.content.slice(0, 240),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const reason = ac.signal.aborted ? 'timeout after 5s' : msg;
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timeout);
    }
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

  async updateProfile(
    id: string,
    input: {
      name?: string;
      preferenceOrder?: string[];
      capabilityRouting?: Record<string, unknown>;
    },
  ) {
    const t = this.tenant.require();
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.preferenceOrder !== undefined) data.preferenceOrder = input.preferenceOrder as any;
    if (input.capabilityRouting !== undefined) data.capabilityRouting = input.capabilityRouting as any;
    return this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProfile.update({ where: { id }, data }),
    );
  }

  async deleteProfile(id: string) {
    const t = this.tenant.require();
    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.llmProfile.delete({ where: { id } }),
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

/**
 * Map model id → capabilities for a stored LlmProvider row, without needing
 * the credential. `capabilitiesFor()` is pure on (kind, modelId, overrides),
 * so we can compute this server-side and ship it to the UI.
 */
function capabilityMapFor(row: {
  kind: string;
  endpoint: string | null;
  capabilityOverrides: unknown;
}): Record<string, ModelCapability> {
  const overrides = (row.capabilityOverrides ?? {}) as Record<string, unknown>;
  const models = Array.isArray((overrides as { models?: unknown }).models)
    ? ((overrides as { models?: string[] }).models ?? [])
    : [];
  if (models.length === 0) return {};
  const cfg = {
    id: '__capability_only__',
    kind: row.kind as 'anthropic' | 'openai' | 'bedrock' | 'ollama',
    endpoint: row.endpoint ?? undefined,
    models,
    capabilityOverrides: overrides as Record<string, ModelCapability>,
  };
  const out: Record<string, ModelCapability> = {};
  for (const m of models) {
    out[m] = capabilitiesFor(cfg, m);
  }
  return out;
}
