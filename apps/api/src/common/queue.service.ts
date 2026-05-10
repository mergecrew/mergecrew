import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

export type QueueName =
  | 'run.due'
  | 'orchestrator.dispatch'
  | 'runner.step'
  | 'orchestrator.gate.resume'
  | 'orchestrator.rate-limit.resume'
  | 'webhook.inbound'
  | 'webhook.outbound';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private connection: Redis;
  private queues = new Map<QueueName, Queue>();

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
  }

  get(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  connectionHandle(): Redis {
    return this.connection;
  }

  async onModuleDestroy(): Promise<void> {
    for (const q of this.queues.values()) await q.close();
    await this.connection.quit();
  }
}
