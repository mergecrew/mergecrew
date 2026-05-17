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
  const [lc, project, catalog, canEdit, layout, stockTemplates] = await Promise.all([
    apiOr404<{ version: number; sourceYaml: string; parsed: ParsedConfig; name: string | null }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle`,
      { session },
    ),
    apiOr404<{ demo?: boolean }>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
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
  const isDemo = Boolean(project.demo);

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
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Template
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Pre-built Planner / Coder / Reviewer setups tuned for common stacks. Applying a
                template replaces this project&apos;s lifecycle YAML — the previous version stays
                in the versions list. Use <span className="font-medium">Apply &amp; customize</span> to
                jump into the YAML editor after applying.
              </p>
            </div>
            {lc.name && (
              <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                Active: <span className="font-mono">{lc.name}</span>
              </span>
            )}
          </div>
          {isDemo ? (
            <p className="text-sm text-zinc-500">
              Read-only on the demo project. Set up your own project to apply a template.
            </p>
          ) : (
            <StockTemplatePicker
              scope={scope}
              templates={stockTemplates.items}
              activeTemplateId={lc.name}
            />
          )}
        </Card>
      )}
      <Card>
        <div id="lifecycle-yaml-editor">
          <LifecycleEditor
            scope={scope}
            parsed={{ ...lc.parsed, version: lc.version }}
            sourceYaml={lc.sourceYaml ?? ''}
            catalog={catalog.items}
            showApplyTemplate={!isDemo}
            readOnly={!canEdit || isDemo}
            graphLayout={layout.positions}
            graphLayoutEditable={canEditOrOperator && !isDemo}
          />
        </div>
      </Card>
    </main>
  );
}
