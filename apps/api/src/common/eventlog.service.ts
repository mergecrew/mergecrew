import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Eventlog, RedisPubSub } from '@mergecrew/eventlog';

@Injectable()
export class EventlogService implements OnModuleDestroy {
  private pubsub: RedisPubSub;
  readonly eventlog: Eventlog;

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.pubsub = new RedisPubSub(url);
    this.eventlog = new Eventlog(this.pubsub);
  }

  pubsubHandle(): RedisPubSub {
    return this.pubsub;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pubsub.close();
  }
}
