import { Module } from '@nestjs/common';
import { SloController } from './slo.controller.js';

@Module({ controllers: [SloController] })
export class SloModule {}
