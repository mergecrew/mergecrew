import type { ReactNode } from 'react';
import { TopBar } from '@/components/shell/topbar';
import { OrgSidebar } from '@/components/shell/sidebar';
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
    <div className="grid h-screen grid-rows-[56px_1fr] grid-cols-[260px_1fr] bg-bg">
      <div className="col-span-2">
        <TopBar
          orgSlug={slug}
          orgName={org?.name}
          demoMode={demoMode}
          userMenu={<UserMenu currentOrgSlug={slug} />}
        />
      </div>
      <OrgSidebar
        orgSlug={slug}
        orgName={org?.name}
        projectCount={org?.projectCount}
        mtdSpend={formatUsd(org?.mtdSpendUsd)}
        monthlyCap={formatUsd(org?.monthlyCapUsd)}
      />
      <main className="overflow-y-auto">{children}</main>
    </div>
  );
}
