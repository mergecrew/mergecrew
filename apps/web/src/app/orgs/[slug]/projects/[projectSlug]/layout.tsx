import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { TopBar } from '@/components/shell/topbar';
import { ProjectSidebar } from '@/components/shell/sidebar';
import { AppShell } from '@/components/shell/app-shell';
import { UserMenu } from '@/components/user-menu';

type Project = {
  name: string;
  slug: string;
  status?: 'running' | 'paused' | 'failed';
  awaitingApproval?: boolean;
};

type OrgSummary = { name: string; slug: string };

type ProjectHealth = {
  worstState: 'OK' | 'AT_RISK' | 'BREACHING' | 'INSUFFICIENT_DATA' | 'UNCONFIGURED';
  breachingSloNames: string[];
  atRiskSloNames: string[];
};

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
  let health: ProjectHealth | null = null;
  try {
    [project, org, health] = await Promise.all([
      api<Project>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
      api<OrgSummary>(`/v1/orgs/${slug}`, { session }).catch(() => null) as Promise<OrgSummary | null>,
      api<ProjectHealth>(`/v1/orgs/${slug}/projects/${projectSlug}/health`, { session }).catch(
        () => null,
      ) as Promise<ProjectHealth | null>,
    ]);
  } catch {
    /* fall through; pages will surface the error */
  }

  return (
    <AppShell
      topbar={
        <TopBar
          orgSlug={slug}
          orgName={org?.name}
          projectSlug={projectSlug}
          projectName={project?.name}
          demoMode={demoMode}
          userMenu={<UserMenu currentOrgSlug={slug} />}
        />
      }
      sidebar={
        <ProjectSidebar
          orgSlug={slug}
          projectSlug={projectSlug}
          projectName={project?.name}
          status={project?.status ?? 'running'}
          awaitingApproval={project?.awaitingApproval}
          health={health}
        />
      }
    >
      {children}
    </AppShell>
  );
}
