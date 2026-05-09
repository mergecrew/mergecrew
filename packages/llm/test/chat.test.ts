import { describe, it, expect } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { chat, extractUsage, type ChatTurnRecord } from '../src/chat.js';

/**
 * Provider-agnostic chat tests using a fake model. Real-provider integration
 * is out of scope for unit tests (no API keys in CI) but the same
 * `chat({ ... })` callable is what production uses, so this exercises the
 * actual code path apart from the network leg.
 */

describe('chat()', () => {
  it('returns content + records the turn via onTurn', async () => {
    const fake = new FakeListChatModel({ responses: ['hello from fake'] });
    const recorded: ChatTurnRecord[] = [];

    const r = await chat({
      model: fake as any,
      providerId: 'fake',
      modelId: 'fake-model',
      messages: [new HumanMessage('hi')],
      onTurn: (t) => {
        recorded.push(t);
      },
    });

    expect(r.content).toBe('hello from fake');
    expect(r.providerId).toBe('fake');
    expect(r.modelId).toBe('fake-model');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.providerId).toBe('fake');
    expect(recorded[0]?.modelId).toBe('fake-model');
  });

  it('awaits async onTurn before resolving', async () => {
    const fake = new FakeListChatModel({ responses: ['second'] });
    let resolved = false;
    await chat({
      model: fake as any,
      providerId: 'p',
      modelId: 'm',
      messages: [new HumanMessage('q')],
      onTurn: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    expect(resolved).toBe(true);
  });

  it('still returns a result when no onTurn is given', async () => {
    const fake = new FakeListChatModel({ responses: ['no callback'] });
    const r = await chat({
      model: fake as any,
      providerId: 'p',
      modelId: 'm',
      messages: [new HumanMessage('q')],
    });
    expect(r.content).toBe('no callback');
  });

  it('cycles responses across calls (sanity check on the fake)', async () => {
    const fake = new FakeListChatModel({ responses: ['one', 'two'] });
    const r1 = await chat({
      model: fake as any,
      providerId: 'p',
      modelId: 'm',
      messages: [new HumanMessage('q')],
    });
    const r2 = await chat({
      model: fake as any,
      providerId: 'p',
      modelId: 'm',
      messages: [new HumanMessage('q')],
    });
    expect([r1.content, r2.content]).toEqual(['one', 'two']);
  });
});

describe('extractUsage()', () => {
  it('reads input/output tokens from usage_metadata', () => {
    const msg = new AIMessage({ content: 'x' });
    (msg as any).usage_metadata = { input_tokens: 12, output_tokens: 34 };
    const u = extractUsage(msg);
    expect(u.inputTokens).toBe(12);
    expect(u.outputTokens).toBe(34);
    expect(u.totalTokens).toBe(46);
  });

  it('honors provider-supplied total_tokens when present', () => {
    const msg = new AIMessage({ content: 'x' });
    (msg as any).usage_metadata = {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 100,
    };
    expect(extractUsage(msg).totalTokens).toBe(100);
  });

  it('extracts cache + thinking detail tokens when present', () => {
    const msg = new AIMessage({ content: 'x' });
    (msg as any).usage_metadata = {
      input_tokens: 5,
      output_tokens: 7,
      input_token_details: { cache_read: 3, cache_creation: 2 },
      output_token_details: { reasoning: 4 },
    };
    const u = extractUsage(msg);
    expect(u.cacheReadTokens).toBe(3);
    expect(u.cacheWriteTokens).toBe(2);
    expect(u.thinkingTokens).toBe(4);
  });

  it('returns zeros when usage_metadata is missing entirely', () => {
    const msg = new AIMessage({ content: 'x' });
    const u = extractUsage(msg);
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.totalTokens).toBe(0);
  });
});
