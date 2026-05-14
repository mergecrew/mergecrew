import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import {
  LifecycleEditor,
  type ParsedConfig,
} from '@/components/lifecycle/lifecycle-editor';
import type { LifecycleScope } from '@/components/lifecycle/scope';
import {
  StockTemplatePicker,
  type StockTemplateSummary,
} from '@/components/lifecycle/stock-template-picker';

interface SkillRow {
  name: string;
  description: string;
  sideEffectClass: string;
}

export default async function LifecyclePage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const [lc, catalog, canEdit, layout, stockTemplates] = await Promise.all([
    apiOr404<{ version: number; sourceYaml: string; parsed: ParsedConfig }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle`,
      { session },
    ),
    api<{ items: SkillRow[] }>('/v1/skills', { session }),
    hasRole(slug, session, 'admin'),
    // V2.1 phase 2 (#195): persisted node positions, applied if present.
    api<{ positions: Record<string, { x: number; y: number }> }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle/graph-layout`,
      { session },
    ).catch(() => ({ positions: {} })),
    // Stock template catalog (#393, V2.ai). Public endpoint — failure
    // here shouldn't block the editor, so we fall back to an empty list.
    api<{ items: StockTemplateSummary[] }>(`/v1/lifecycle-templates/stock`, { session }).catch(
      () => ({ items: [] }),
    ),
  ]);

  const scope: LifecycleScope = { kind: 'project', orgSlug: slug, projectSlug };
  const canEditOrOperator = await hasRole(slug, session, 'operator');

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Lifecycle</h1>
        <p className="text-sm text-zinc-500">
          Configure the agents, workflows, custom skills, and human gates that run for this project.
          Each save creates a new versioned snapshot.
        </p>
      </header>
      {canEdit && stockTemplates.items.length > 0 && (
        <Card>
          <div className="mb-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Start from a stock template
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Pre-built Planner / Coder / Reviewer setups tuned for common stacks. Applying a template replaces this project&apos;s lifecycle — the previous version is kept in the versions list.
            </p>
          </div>
          <StockTemplatePicker scope={scope} templates={stockTemplates.items} />
        </Card>
      )}
      <Card>
        <LifecycleEditor
          scope={scope}
          parsed={{ ...lc.parsed, version: lc.version }}
          sourceYaml={lc.sourceYaml ?? ''}
          catalog={catalog.items}
          showApplyTemplate
          readOnly={!canEdit}
          graphLayout={layout.positions}
          graphLayoutEditable={canEditOrOperator}
        />
      </Card>
    </main>
  );
}
