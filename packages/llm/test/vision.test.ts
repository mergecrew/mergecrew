import { describe, it, expect } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage } from '@langchain/core/messages';
import { chat } from '../src/chat.js';
import { hasVisionContent, imageBlock, imageUrlBlock } from '../src/vision.js';
import { ProviderRegistry } from '../src/registry.js';

describe('vision helpers', () => {
  it('imageBlock encodes raw bytes as base64 data URL', () => {
    const b = imageBlock({ data: Buffer.from('hello'), mimeType: 'image/png' });
    expect(b.type).toBe('image_url');
    expect(b.image_url.url).toBe(`data:image/png;base64,${Buffer.from('hello').toString('base64')}`);
  });

  it('imageUrlBlock passes through remote URLs', () => {
    const b = imageUrlBlock('https://example.com/x.png', 'high');
    expect(b.image_url.url).toBe('https://example.com/x.png');
    expect(b.image_url.detail).toBe('high');
  });

  it('hasVisionContent finds image blocks in mixed content', () => {
    expect(hasVisionContent([new HumanMessage({ content: 'just text' })])).toBe(false);
    const img = imageUrlBlock('https://example.com/x.png');
    const m = new HumanMessage({ content: [{ type: 'text', text: 'look' }, img] as any });
    expect(hasVisionContent([m])).toBe(true);
  });
});

describe('chat() vision preflight', () => {
  it('refuses image content when the registry model lacks vision', async () => {
    const registry = new ProviderRegistry([
      {
        id: 'fake-noimg',
        kind: 'ollama',
        models: ['llama3.2'],
      },
    ]);
    const messages = [
      new HumanMessage({
        content: [
          { type: 'text', text: 'what is this?' },
          imageUrlBlock('https://example.com/x.png'),
        ] as any,
      }),
    ];

    await expect(
      chat({
        registry,
        providerId: 'fake-noimg',
        modelId: 'llama3.2',
        messages,
      }),
    ).rejects.toThrow(/does not support vision input/);
  });

  it('passes through to the model when vision is unused', async () => {
    const fake = new FakeListChatModel({ responses: ['ok'] });
    const r = await chat({
      model: fake as any,
      providerId: 'fake',
      modelId: 'fake-model',
      messages: [new HumanMessage({ content: 'hi' })],
    });
    expect(r.content).toBe('ok');
  });
});
