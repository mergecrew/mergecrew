import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card } from '@/components/ui';
import { AutoPromoteEditor } from '@/components/auto-promote-editor';

interface AutoPromoteRule {
  name: string;
  pathPatterns: string[];
  maxFilesChanged?: number;
  maxLinesChanged?: number;
  requireDocsOnly?: boolean;
  requirePackageJsonPatchOnly?: boolean;
}

export default async function AutoPromotePage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const [{ rules }, canEdit] = await Promise.all([
    api<{ rules: AutoPromoteRule[] }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/auto-promote`,
      { session },
    ),
    hasRole(slug, session, 'operator'),
  ]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Auto-promote rules</h1>
        <p className="text-sm text-zinc-500">
          Changesets that match any rule below will skip human review and auto-promote.
          Empty list = every changeset goes through the manual approval gate.
        </p>
      </header>

      <Card>
        <AutoPromoteEditor
          initialRules={rules}
          canEdit={canEdit}
          onSave={async (next) => {
            'use server';
            try {
              const session = await requireSession();
              await api(`/v1/orgs/${slug}/projects/${projectSlug}/auto-promote`, {
                method: 'PUT',
                body: JSON.stringify({ rules: next }),
                session,
              });
              revalidatePath(
                `/orgs/${slug}/projects/${projectSlug}/settings/auto-promote`,
              );
              return { ok: true } as const;
            } catch (e: any) {
              return { ok: false, error: String(e?.message ?? e) } as const;
            }
          }}
        />
      </Card>
    </main>
  );
}
