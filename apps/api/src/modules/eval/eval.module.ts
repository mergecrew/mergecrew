import { Module } from '@nestjs/common';
import { EvalController } from './eval.controller.js';
import { EvalService } from './eval.service.js';

@Module({
  controllers: [EvalController],
  providers: [EvalService],
})
export class EvalModule {}
