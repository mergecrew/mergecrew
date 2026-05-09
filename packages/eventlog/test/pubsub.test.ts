import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { RedisPubSub } from '../src/pubsub.js';

/**
 * Stand-in for an IORedis client. Captures `subscribe` calls so the test
 * can assert that N handlers on the same channel only allocate ONE
 * subscription (the per-process SSE fanout multiplex).
 *
 * Implements just the surface RedisPubSub touches: publish, subscribe,
 * unsubscribe, duplicate, on/quit, plus the EventEmitter `message` channel
 * pubsub uses to dispatch.
 */
class FakeRedis extends EventEmitter {
  static all: FakeRedis[] = [];
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  quit = async (): Promise<void> => undefined;

  constructor() {
    super();
    FakeRedis.all.push(this);
  }

  publish = async (channel: string, payload: string): Promise<number> => {
    // Walk all FakeRedis instances and emit `message` to ones subscribed
    // to this channel. Mirrors how Redis pubsub fans out across processes.
    for (const r of FakeRedis.all) {
      if (r.subscribeCalls.includes(channel)) r.emit('message', channel, payload);
    }
    return 1;
  };

  subscribe = async (channel: string): Promise<number> => {
    this.subscribeCalls.push(channel);
    return this.subscribeCalls.length;
  };

  unsubscribe = async (channel: string): Promise<number> => {
    this.unsubscribeCalls.push(channel);
    return Math.max(0, this.subscribeCalls.length - this.unsubscribeCalls.length);
  };

  duplicate = (): Redis => new FakeRedis() as unknown as Redis;
}

function freshFactory(): () => Redis {
  FakeRedis.all = [];
  return () => new FakeRedis() as unknown as Redis;
}

describe('RedisPubSub fanout multiplex', () => {
  it('two handlers on the same channel share one subscriber connection', async () => {
    const pubsub = new RedisPubSub(freshFactory());
    const got: string[] = [];

    const u1 = await pubsub.subscribe<{ n: number }>('run:abc', (m) => {
      got.push(`a:${m.n}`);
    });
    const u2 = await pubsub.subscribe<{ n: number }>('run:abc', (m) => {
      got.push(`b:${m.n}`);
    });

    // FakeRedis instances created so far: [publisher, subscriber-for-abc].
    // The publisher is index 0; only the subscriber should have subscribed.
    expect(FakeRedis.all.length).toBe(2);
    expect(FakeRedis.all[0]!.subscribeCalls).toEqual([]);
    expect(FakeRedis.all[1]!.subscribeCalls).toEqual(['run:abc']);

    await pubsub.publish('run:abc', { n: 1 });
    // Drain microtasks — handlers are awaited via Promise.resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(got.sort()).toEqual(['a:1', 'b:1']);

    await u1();
    await u2();
    expect(FakeRedis.all[1]!.unsubscribeCalls).toEqual(['run:abc']);

    await pubsub.close();
  });

  it('different channels open separate subscriber connections', async () => {
    const pubsub = new RedisPubSub(freshFactory());
    const u1 = await pubsub.subscribe('run:abc', () => undefined);
    const u2 = await pubsub.subscribe('run:def', () => undefined);

    // [publisher, sub-abc, sub-def]
    expect(FakeRedis.all.length).toBe(3);
    expect(FakeRedis.all[1]!.subscribeCalls).toEqual(['run:abc']);
    expect(FakeRedis.all[2]!.subscribeCalls).toEqual(['run:def']);

    await u1();
    await u2();
    await pubsub.close();
  });

  it('unsubscribing one of two handlers does NOT tear down the connection', async () => {
    const pubsub = new RedisPubSub(freshFactory());
    const u1 = await pubsub.subscribe('run:abc', () => undefined);
    const u2 = await pubsub.subscribe('run:abc', () => undefined);

    await u1();
    expect(FakeRedis.all[1]!.unsubscribeCalls).toEqual([]); // u2 still attached

    await u2();
    expect(FakeRedis.all[1]!.unsubscribeCalls).toEqual(['run:abc']);

    await pubsub.close();
  });
});
