import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { RunnerAgentController } from './runner-agent.controller.js';
import { RunnerAgentPublicController } from './runner-agent-public.controller.js';
import { RunnerAgentService } from './runner-agent.service.js';
import { SandboxOpsController } from './sandbox-ops.controller.js';
import { SandboxOpsService } from './sandbox-ops.service.js';

@Module({
  imports: [CommonModule],
  controllers: [RunnerAgentController, RunnerAgentPublicController, SandboxOpsController],
  providers: [RunnerAgentService, SandboxOpsService],
  exports: [RunnerAgentService, SandboxOpsService],
})
export class RunnerAgentModule {}
