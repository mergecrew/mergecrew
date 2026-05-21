import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { TopBar } from '@/components/shell/topbar';
import { ProjectSidebar } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/user-menu';

type Project = {
  name: string;
  slug: string;
  status?: 'running' | 'paused' | 'failed';
  awaitingApproval?: boolean;
};

type OrgSummary = { name: string; slug: string };

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const demoMode = process.env.MERGECREW_DEMO_MODE === '1';

  let project: Project | null = null;
  let org: OrgSummary | null = null;
  try {
    [project, org] = await Promise.all([
      api<Project>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
      api<OrgSummary>(`/v1/orgs/${slug}`, { session }).catch(() => null) as Promise<OrgSummary | null>,
    ]);
  } catch {
    /* fall through; pages will surface the error */
  }

  return (
    <div className="grid h-screen grid-rows-[56px_1fr] grid-cols-[260px_1fr] bg-bg">
      <div className="col-span-2">
        <TopBar
          orgSlug={slug}
          orgName={org?.name}
          projectSlug={projectSlug}
          projectName={project?.name}
          demoMode={demoMode}
          userMenu={<UserMenu currentOrgSlug={slug} />}
        />
      </div>
      <ProjectSidebar
        orgSlug={slug}
        projectSlug={projectSlug}
        projectName={project?.name}
        status={project?.status ?? 'running'}
        awaitingApproval={project?.awaitingApproval}
      />
      <main className="overflow-y-auto">{children}</main>
    </div>
  );
}
