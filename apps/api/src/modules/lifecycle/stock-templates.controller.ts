import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  STOCK_LIFECYCLE_TEMPLATES,
  findStockLifecycleTemplate,
} from '@mergecrew/domain';

/**
 * Public catalog of stock lifecycle templates (#393, V2.ai).
 *
 * The data is static and shared across tenants — same shape as the
 * `v1/skills` endpoint (#324) — so no tenant guard or session check
 * is needed. Consumers: the project Lifecycle picker (#394) and the
 * onboarding wizard's 5th step (#395), both of which let the operator
 * preview templates *before* a project exists, so this endpoint must
 * not depend on a project/org context.
 *
 * Note this is distinct from the *org-scoped* template store at
 * `v1/orgs/:slug/lifecycle-templates` (the OrgTemplateController),
 * which holds operator-customized templates persisted per org.
 */
@Controller('v1/lifecycle-templates/stock')
export class StockTemplateController {
  @Get()
  list() {
    return {
      items: STOCK_LIFECYCLE_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        stack: t.stack,
      })),
    };
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    const tpl = findStockLifecycleTemplate(id);
    if (!tpl) {
      throw new NotFoundException(`unknown stock lifecycle template: ${id}`);
    }
    // Full payload (including sourceYaml + parsed) is only returned on
    // the detail endpoint to keep the list response small for pickers
    // that just render names and descriptions.
    return {
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      stack: tpl.stack,
      sourceYaml: tpl.sourceYaml,
      parsed: tpl.parsed,
    };
  }
}
