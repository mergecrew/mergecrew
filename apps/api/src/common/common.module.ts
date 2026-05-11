import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { TenantContextService } from './tenant-context.service.js';
import { EventlogService } from './eventlog.service.js';
import { QueueService } from './queue.service.js';
import { LoggerService } from './logger.service.js';
import { CryptoService } from './crypto.service.js';
import { TelemetryService } from './telemetry.service.js';

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
