import {
  ProviderUnavailableError,
  type ModelCapability,
  type ProviderRef,
} from '@mergecrew/domain';
import { CircuitBreaker } from './circuit-breaker.js';
import type { LlmProfile } from './types.js';
import type { ProviderRegistry } from './registry.js';

export interface ResolveRequest {
  capability: ModelCapability;
  profile: LlmProfile;
  override?: ProviderRef;
}

export interface Resolved {
  providerId: string;
  modelId: string;
  ref: ProviderRef;
}

export class CapabilityRouter {
  constructor(
    private registry: ProviderRegistry,
    private breaker: CircuitBreaker,
  ) {}

  resolve(req: ResolveRequest): Resolved {
    const candidates: string[] = [];
    if (req.override) candidates.push(req.override);
    candidates.push(...req.profile.preferenceOrder);

    for (const ref of candidates) {
      const r = this.tryCandidate(ref, req.capability);
      if (r) return r;
    }
    throw new ProviderUnavailableError(
      'router',
      `no provider satisfies capability ${JSON.stringify(req.capability)}`,
    );
  }

  private tryCandidate(ref: string, need: ModelCapability): Resolved | null {
    const slash = ref.indexOf('/');
    if (slash < 0) return null;
    const providerId = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);

    if (!this.registry.has(providerId)) return null;
    if (!this.registry.modelIds(providerId).includes(modelId)) return null;
    if (!this.satisfies(this.registry.capabilities(providerId, modelId), need)) return null;

    const key = `${providerId}/${modelId}`;
    if (this.breaker.isOpen(key)) return null;
    return { providerId, modelId, ref: ref as ProviderRef };
  }

  satisfies(have: ModelCapability, need: ModelCapability): boolean {
    if (need.reasoning && !have.reasoning) return false;
    if (need.tools && !have.tools) return false;
    if (need.parallelTools && !have.parallelTools) return false;
    if (need.vision && !have.vision) return false;
    if (need.embedding && !have.embedding) return false;
    if (need.thinking && !have.thinking) return false;
    if (need.promptCache && !have.promptCache) return false;
    if (need.responseJsonSchema && !have.responseJsonSchema) return false;
    if (need.lowLatency && !have.lowLatency) return false;
    if (need.longContext) {
      const haveCtx = have.longContext ?? 0;
      if (haveCtx < need.longContext) return false;
    }
    return true;
  }

  recordOutcome(providerId: string, modelId: string, ok: boolean): void {
    const key = `${providerId}/${modelId}`;
    if (ok) this.breaker.recordSuccess(key);
    else this.breaker.recordFailure(key);
  }

  registryHandle(): ProviderRegistry {
    return this.registry;
  }
}
