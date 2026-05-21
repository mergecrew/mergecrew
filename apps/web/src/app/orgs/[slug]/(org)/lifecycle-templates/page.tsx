import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, PageHead } from '@/components/ui';
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
      <main className="mx-auto max-w-[1080px] px-9 py-7">
        <PageHead
          crumb={[
            { label: slug, href: `/orgs/${slug}` },
            { label: 'Lifecycle templates' },
          ]}
          title="Lifecycle templates"
        />
        <Card className="p-5">
          <p className="m-0 text-[13.5px] text-muted">
            No template stored. The first save will create one.
          </p>
        </Card>
      </main>
    );
  }

  const scope: LifecycleScope = {
    kind: 'org-template',
    orgSlug: slug,
    templateName: 'default',
  };

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Lifecycle templates' },
        ]}
        title="Lifecycle template · default"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Org-wide template applied to new projects, or via &quot;Apply org default
            template&quot; on the project&apos;s Lifecycle page.
          </span>
        }
      />

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
