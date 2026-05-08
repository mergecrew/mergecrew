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
  /**
   * Agent kind (e.g. 'planner', 'coder', 'bug-triage'). When set and the
   * profile declares `capabilityRouting[agentKind]`, those required features
   * are merged with `capability` before resolution. This lets a profile
   * upgrade a specific agent's needs without changing the call sites.
   */
  agentKind?: string;
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
    const need = this.requiredCapability(req);
    const candidates: string[] = [];
    if (req.override) candidates.push(req.override);
    candidates.push(...req.profile.preferenceOrder);

    for (const ref of candidates) {
      const r = this.tryCandidate(ref, need);
      if (r) return r;
    }
    throw new ProviderUnavailableError(
      'router',
      `no provider satisfies capability ${JSON.stringify(need)}`,
    );
  }

  private requiredCapability(req: ResolveRequest): ModelCapability {
    const perAgent =
      req.agentKind && req.profile.capabilityRouting
        ? req.profile.capabilityRouting[req.agentKind]
        : undefined;
    return perAgent ? mergeCapabilities(req.capability, perAgent) : req.capability;
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

function mergeCapabilities(a: ModelCapability, b: ModelCapability): ModelCapability {
  const merged: ModelCapability = {
    ...(a.reasoning || b.reasoning ? { reasoning: true } : {}),
    ...(a.tools || b.tools ? { tools: true } : {}),
    ...(a.parallelTools || b.parallelTools ? { parallelTools: true } : {}),
    ...(a.vision || b.vision ? { vision: true } : {}),
    ...(a.embedding || b.embedding ? { embedding: true } : {}),
    ...(a.thinking || b.thinking ? { thinking: true } : {}),
    ...(a.promptCache || b.promptCache ? { promptCache: true } : {}),
    ...(a.responseJsonSchema || b.responseJsonSchema ? { responseJsonSchema: true } : {}),
    ...(a.lowLatency || b.lowLatency ? { lowLatency: true } : {}),
  };
  const longest = (a.longContext ?? 0) >= (b.longContext ?? 0) ? a.longContext : b.longContext;
  if (longest) merged.longContext = longest;
  return merged;
}
