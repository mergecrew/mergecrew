import { Module } from '@nestjs/common';
import { SloController } from './slo.controller.js';
import { HealthController } from './health.controller.js';

@Module({ controllers: [SloController, HealthController] })
export class SloModule {}
