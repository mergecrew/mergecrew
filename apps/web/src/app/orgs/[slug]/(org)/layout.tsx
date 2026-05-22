import type { ReactNode } from 'react';
import { TopBar } from '@/components/shell/topbar';
import { OrgSidebar } from '@/components/shell/sidebar';
import { AppShell } from '@/components/shell/app-shell';
import { UserMenu } from '@/components/user-menu';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';

type OrgSummary = {
  slug: string;
  name: string;
  projectCount?: number;
  mtdSpendUsd?: number;
  monthlyCapUsd?: number;
};

export default async function OrgChromeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const demoMode = process.env.MERGECREW_DEMO_MODE === '1';

  // Best-effort org lookup so the sidebar can show a friendly name +
  // spend snapshot. Anything failing falls back to the slug — page
  // bodies still own the canonical error path.
  let org: OrgSummary | null = null;
  try {
    const session = await getSession();
    if (session) {
      org = await api<OrgSummary>(`/v1/orgs/${slug}`, { session });
    }
  } catch {
    /* fall through */
  }

  const formatUsd = (n?: number) =>
    n == null ? undefined : `$${n.toFixed(n >= 100 ? 0 : 2)}`;

  return (
    <AppShell
      topbar={
        <TopBar
          orgSlug={slug}
          orgName={org?.name}
          demoMode={demoMode}
          userMenu={<UserMenu currentOrgSlug={slug} />}
        />
      }
      sidebar={
        <OrgSidebar
          orgSlug={slug}
          orgName={org?.name}
          projectCount={org?.projectCount}
          mtdSpend={formatUsd(org?.mtdSpendUsd)}
          monthlyCap={formatUsd(org?.monthlyCapUsd)}
        />
      }
    >
      {children}
    </AppShell>
  );
}
