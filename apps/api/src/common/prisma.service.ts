import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { getPrisma, withTenant, withSystem, type Tx } from '@mergecrew/db';
import type { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  client(): PrismaClient {
    return getPrisma();
  }

  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(orgId, fn);
  }

  withSystem<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return withSystem(fn);
  }

  async onModuleDestroy(): Promise<void> {
    await getPrisma().$disconnect();
  }
}
