import IORedis, { type Redis } from 'ioredis';

export type Subscriber<T> = (msg: T) => void | Promise<void>;

/**
 * Thin Redis pubsub wrapper. We use one publisher connection (re-usable) and
 * dedicated subscriber connections per topic — IORedis requires a subscriber
 * connection to be exclusively in subscribe mode.
 */
export class RedisPubSub {
  private publisher: Redis;
  private subscribers = new Map<string, { conn: Redis; handlers: Set<Subscriber<unknown>> }>();

  constructor(url: string) {
    this.publisher = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
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
