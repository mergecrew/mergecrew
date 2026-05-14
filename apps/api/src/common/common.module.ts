import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from './prisma.service.js';
import { TenantContextService } from './tenant-context.service.js';
import { EventlogService } from './eventlog.service.js';
import { QueueService } from './queue.service.js';
import { LoggerService } from './logger.service.js';
import { CryptoService } from './crypto.service.js';
import { TelemetryService } from './telemetry.service.js';
import { DemoProjectGuard } from './demo-project.guard.js';

@Global()
@Module({
  providers: [
    PrismaService,
    TenantContextService,
    EventlogService,
    QueueService,
    LoggerService,
    CryptoService,
    TelemetryService,
    // Global read-only guard for demo projects (#438). Self-skips on
    // safe methods, non-project routes, and `MERGECREW_DEMO_MODE=1`.
    { provide: APP_GUARD, useClass: DemoProjectGuard },
  ],
  exports: [
    PrismaService,
    TenantContextService,
    EventlogService,
    QueueService,
    LoggerService,
    CryptoService,
    TelemetryService,
  ],
})
export class CommonModule {}
