import { Module } from '@nestjs/common';
import { CostController } from './cost.controller.js';

@Module({ controllers: [CostController] })
export class CostModule {}
