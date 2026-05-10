import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Eventlog, RedisPubSub, fanoutToBullmq } from '@mergecrew/eventlog';

@Injectable()
export class EventlogService implements OnModuleDestroy {
  private pubsub: RedisPubSub;
  private fanoutQueue: Queue;
  private connection: Redis;
  readonly eventlog: Eventlog;

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pubsub = new RedisPubSub(url);
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
    // Sharing one bullmq Queue handle is the recommended pattern; the
    // orchestrator owns the worker side.
    this.fanoutQueue = new Queue('webhook.fanout', { connection: this.connection });
    this.eventlog = new Eventlog(this.pubsub, fanoutToBullmq(this.fanoutQueue));
  }

  pubsubHandle(): RedisPubSub {
    return this.pubsub;
  }

  async onModuleDestroy(): Promise<void> {
    await this.fanoutQueue.close();
    await this.connection.quit();
    await this.pubsub.close();
  }
}
