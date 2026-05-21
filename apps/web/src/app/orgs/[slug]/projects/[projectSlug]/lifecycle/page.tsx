import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Label, PageHead, StatBadge } from '@/components/ui';
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
    api<{ positions: Record<string, { x: number; y: number }> }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle/graph-layout`,
      { session },
    ).catch(() => ({ positions: {} })),
    api<{ items: StockTemplateSummary[] }>(
      `/v1/lifecycle-templates/stock`,
      { session },
    ).catch(() => ({ items: [] })),
  ]);

  const scope: LifecycleScope = { kind: 'project', orgSlug: slug, projectSlug };
  const canEditOrOperator = await hasRole(slug, session, 'operator');
  const isDemo = Boolean(project.demo);

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Lifecycle' },
        ]}
        title="Lifecycle"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            v{lc.version}
            {lc.name ? ` · ${lc.name}` : ''} · each save creates a new versioned snapshot
          </span>
        }
        actions={lc.name ? <StatBadge kind="accent">Active</StatBadge> : null}
      />

      <div className="space-y-4">
        {canEdit && stockTemplates.items.length > 0 && (
          <Card className="p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div>
                <Label className="block mb-2">Templates</Label>
                <p className="m-0 text-[12.5px] leading-[1.55] text-muted">
                  Pre-built Planner / Coder / Reviewer setups tuned for common stacks. Applying a
                  template replaces this project&apos;s lifecycle YAML — the previous version
                  stays in the versions list. Use{' '}
                  <span className="font-medium text-ink">Apply &amp; customize</span> to jump into
                  the YAML editor after applying.
                </p>
              </div>
              {lc.name && (
                <span className="shrink-0 bg-accent-soft px-[10px] py-[3px] font-mono text-[11px] uppercase tracking-[0.06em] text-accent-deep">
                  Active: <span className="ml-1">{lc.name}</span>
                </span>
              )}
            </div>
            {isDemo ? (
              <p className="m-0 text-[13px] text-muted">
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
      </div>
    </main>
  );
}
