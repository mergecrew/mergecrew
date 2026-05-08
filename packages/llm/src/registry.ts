import { ProviderUnavailableError, type ModelCapability } from '@mergecrew/domain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  buildChatModel,
  buildEmbeddingsModel,
  capabilitiesFor,
  type BuildModelOptions,
  type ProviderConfig,
} from './models.js';

export type { ProviderConfig } from './models.js';

/**
 * Per-org provider registry. Stores configs (apiKey, endpoint, allowed models)
 * and constructs LangChain BaseChatModel instances on demand. The runner
 * creates a registry per agent step, so BYOK keys are not retained across
 * requests.
 */
export class ProviderRegistry {
  private configs = new Map<string, ProviderConfig>();

  constructor(configs: ProviderConfig[]) {
    for (const c of configs) this.configs.set(c.id, c);
  }

  has(id: string): boolean {
    return this.configs.has(id);
  }

  get(id: string): ProviderConfig {
    const c = this.configs.get(id);
    if (!c) throw new ProviderUnavailableError(id, `unknown provider id ${id}`);
    return c;
  }

  list(): ProviderConfig[] {
    return Array.from(this.configs.values());
  }

  modelIds(id: string): string[] {
    return this.get(id).models;
  }

  capabilities(id: string, modelId: string): ModelCapability {
    return capabilitiesFor(this.get(id), modelId);
  }

  buildModel(id: string, modelId: string, opts: BuildModelOptions = {}): BaseChatModel {
    return buildChatModel(this.get(id), modelId, opts);
  }

  buildEmbeddings(id: string, modelId: string): Embeddings {
    const cfg = this.get(id);
    if (!capabilitiesFor(cfg, modelId).embedding) {
      throw new ProviderUnavailableError(
        id,
        `model ${modelId} on provider ${id} (${cfg.kind}) is not declared as an embedding model`,
      );
    }
    return buildEmbeddingsModel(cfg, modelId);
  }
}
