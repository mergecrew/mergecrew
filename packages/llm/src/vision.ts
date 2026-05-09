import type { BaseMessage, MessageContentComplex } from '@langchain/core/messages';

/**
 * One vision content block in the LangChain "complex content" form. All
 * supported providers (Anthropic, OpenAI/GPT-4o+, Bedrock-Claude) accept the
 * `type: 'image_url'` shape with either a base64 data URL or an http(s) URL —
 * the provider adapters handle the normalization downstream.
 */
export interface VisionImageBlock {
  type: 'image_url';
  image_url: {
    /** Either `data:<mime>;base64,<…>` or an absolute http(s) URL. */
    url: string;
    /** Some providers honour the detail hint; harmless when ignored. */
    detail?: 'low' | 'high' | 'auto';
  };
}

/**
 * Build an image content block from raw bytes + MIME type. Encodes inline as
 * a base64 data URL so the caller doesn't need to host the image anywhere.
 *
 * For larger images, prefer passing a URL via `imageUrlBlock()` to keep
 * request payloads small.
 */
export function imageBlock(opts: {
  data: Buffer | Uint8Array | string;
  mimeType: string;
  detail?: 'low' | 'high' | 'auto';
}): VisionImageBlock {
  const base64 =
    typeof opts.data === 'string'
      ? opts.data
      : Buffer.from(opts.data).toString('base64');
  return {
    type: 'image_url',
    image_url: {
      url: `data:${opts.mimeType};base64,${base64}`,
      ...(opts.detail ? { detail: opts.detail } : {}),
    },
  };
}

/** Build a content block referencing a remote http(s) image. */
export function imageUrlBlock(url: string, detail?: 'low' | 'high' | 'auto'): VisionImageBlock {
  return { type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } };
}

/**
 * Convenience: scan a message list and return true when any user/assistant
 * message contains an `image_url` content block. Used by `chat()` to refuse
 * vision input on a model that doesn't have the capability, before paying
 * the round-trip latency.
 */
export function hasVisionContent(messages: BaseMessage[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content as MessageContentComplex[]) {
        if ((block as { type?: string }).type === 'image_url') return true;
      }
    }
  }
  return false;
}
