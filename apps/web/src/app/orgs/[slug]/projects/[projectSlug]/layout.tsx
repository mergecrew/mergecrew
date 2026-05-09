import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { AppBar } from '@/components/app-bar';
import { UserMenu } from '@/components/user-menu';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  let project: { name: string; slug: string } | null = null;
  try {
    project = await api(`/v1/orgs/${slug}/projects/${projectSlug}`, { session });
  } catch {
    /* fall through; pages will surface the error */
  }
  return (
    <>
      <AppBar
        orgSlug={slug}
        project={{ slug: projectSlug, name: project?.name ?? projectSlug }}
        userMenu={<UserMenu currentOrgSlug={slug} />}
      />
      <div className="flex-1">{children}</div>
    </>
  );
}
