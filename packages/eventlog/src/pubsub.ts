import IORedis, { type Redis } from 'ioredis';

export type Subscriber<T> = (msg: T) => void | Promise<void>;

/**
 * Test seam: pass a factory instead of a URL to inject an ioredis-mock-like
 * publisher in unit tests. Production paths always pass the URL string.
 */
export type RedisFactory = () => Redis;

/**
 * Thin Redis pubsub wrapper. We use one publisher connection (re-usable) and
 * one subscriber connection per channel — IORedis requires a subscriber to
 * be exclusively in subscribe mode. Multiple handlers on the same channel
 * SHARE one subscriber connection (refcounted via the handlers Set), which
 * is the per-process SSE fanout multiplex (#124): N viewers on the same
 * run open exactly one Redis subscription regardless of N.
 */
export class RedisPubSub {
  private publisher: Redis;
  private subscribers = new Map<string, { conn: Redis; handlers: Set<Subscriber<unknown>> }>();

  constructor(arg: string | RedisFactory) {
    this.publisher =
      typeof arg === 'string'
        ? new IORedis(arg, { maxRetriesPerRequest: null, lazyConnect: false })
        : arg();
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(payload));
  }

  /**
   * Subscribe to a channel; returns an unsubscribe function. Multiple
   * handlers can share one subscriber connection per channel.
   */
  async subscribe<T>(channel: string, handler: Subscriber<T>): Promise<() => Promise<void>> {
    let entry = this.subscribers.get(channel);
    if (!entry) {
      const conn = this.publisher.duplicate();
      const handlers = new Set<Subscriber<unknown>>();
      entry = { conn, handlers };
      this.subscribers.set(channel, entry);
      await conn.subscribe(channel);
      conn.on('message', (ch, msg) => {
        if (ch !== channel) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg);
        } catch {
          return;
        }
        for (const h of handlers) {
          // Fire and forget; user handlers must not throw.
          void Promise.resolve(h(parsed));
        }
      });
    }
    entry.handlers.add(handler as Subscriber<unknown>);

    return async () => {
      const e = this.subscribers.get(channel);
      if (!e) return;
      e.handlers.delete(handler as Subscriber<unknown>);
      if (e.handlers.size === 0) {
        await e.conn.unsubscribe(channel);
        await e.conn.quit();
        this.subscribers.delete(channel);
      }
    };
  }

  async close(): Promise<void> {
    for (const { conn } of this.subscribers.values()) await conn.quit();
    this.subscribers.clear();
    await this.publisher.quit();
  }
}
