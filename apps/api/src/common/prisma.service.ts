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
    // Prisma 7 (#794): getPrisma() throws if DATABASE_URL is unset.
    // openapi-export instantiates NestJS modules without a DB env
    // and triggers onModuleDestroy on every provider during
    // shutdown — guard so a no-DB lifecycle doesn't crash.
    try {
      await getPrisma().$disconnect();
    } catch {
      /* DB not configured for this process — nothing to disconnect. */
    }
  }
}
