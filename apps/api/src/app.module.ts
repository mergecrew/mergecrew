import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import json from 'express';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrgModule } from './modules/org/org.module.js';
import { ProjectModule } from './modules/project/project.module.js';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module.js';
import { RunModule } from './modules/run/run.module.js';
import { ChangesetModule } from './modules/changeset/changeset.module.js';
import { ApprovalModule } from './modules/approval/approval.module.js';
import { TimelineModule } from './modules/timeline/timeline.module.js';
import { CostModule } from './modules/cost/cost.module.js';
import { LlmModule } from './modules/llm/llm.module.js';
import { IntegrationModule } from './modules/integration/integration.module.js';
import { WebhookModule } from './modules/webhook/webhook.module.js';
import { MfaModule } from './modules/mfa/mfa.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { ApiKeyModule } from './modules/api-key/api-key.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    CommonModule,
    AuthModule,
    OrgModule,
    ProjectModule,
    LifecycleModule,
    RunModule,
    ChangesetModule,
    ApprovalModule,
    TimelineModule,
    CostModule,
    LlmModule,
    IntegrationModule,
    WebhookModule,
    MfaModule,
    AdminModule,
    ApiKeyModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // JSON parser everywhere except webhooks (which need raw bodies for signature verification).
    consumer
      .apply(json.json({ limit: '5mb' }))
      .exclude({ path: 'v1/webhooks/(.*)', method: 0 } as any)
      .forRoutes('*');
    consumer.apply(json.raw({ type: '*/*', limit: '5mb' })).forRoutes('v1/webhooks/*');
    // TenantMiddleware is registered as plain Express middleware in main.ts to
    // sidestep NestJS forRoutes glob quirks.
  }
}
