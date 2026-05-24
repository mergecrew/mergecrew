import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { RunnerAgentController } from './runner-agent.controller.js';
import { RunnerAgentPublicController } from './runner-agent-public.controller.js';
import { RunnerAgentService } from './runner-agent.service.js';

@Module({
  imports: [CommonModule],
  controllers: [RunnerAgentController, RunnerAgentPublicController],
  providers: [RunnerAgentService],
  exports: [RunnerAgentService],
})
export class RunnerAgentModule {}
