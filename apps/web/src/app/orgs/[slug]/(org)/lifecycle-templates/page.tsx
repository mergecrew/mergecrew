import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import {
  LifecycleEditor,
  type ParsedConfig,
} from '@/components/lifecycle/lifecycle-editor';
import type { LifecycleScope } from '@/components/lifecycle/scope';

interface SkillRow {
  name: string;
  description: string;
  sideEffectClass: string;
}

export default async function OrgLifecycleTemplatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const [tpl, catalog, canEdit] = await Promise.all([
    api<{ name: string; sourceYaml: string; parsed: ParsedConfig } | null>(
      `/v1/orgs/${slug}/lifecycle-templates/default`,
      { session },
    ),
    api<{ items: SkillRow[] }>('/v1/skills', { session }),
    hasRole(slug, session, 'admin'),
  ]);

  if (!tpl) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Lifecycle template</h1>
        <p className="mt-2 text-sm text-zinc-500">
          No template stored. The first save will create one.
        </p>
      </main>
    );
  }

  const scope: LifecycleScope = { kind: 'org-template', orgSlug: slug, templateName: 'default' };

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Lifecycle template — default</h1>
        <p className="text-sm text-zinc-500">
          Org-wide template applied to new projects, or to existing projects via "Apply org default
          template" on the project's Lifecycle page.
        </p>
      </header>
      <Card>
        <LifecycleEditor
          scope={scope}
          parsed={{ ...tpl.parsed, version: 1 }}
          sourceYaml={tpl.sourceYaml ?? ''}
          catalog={catalog.items}
          readOnly={!canEdit}
        />
      </Card>
    </main>
  );
}
