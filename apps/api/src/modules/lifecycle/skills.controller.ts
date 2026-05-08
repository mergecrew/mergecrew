import { Controller, Get } from '@nestjs/common';
import { stockSkills } from '@mergecrew/skills';

/**
 * Public skill catalog. Skills are global (not tenant-scoped) — they describe
 * the capabilities the runtime makes available to agents.
 */
@Controller('v1/skills')
export class SkillsController {
  @Get()
  list() {
    return {
      items: stockSkills.map((s) => ({
        name: s.name,
        description: s.description,
        sideEffectClass: s.sideEffectClass,
        capabilities: s.capabilities,
      })),
    };
  }
}
