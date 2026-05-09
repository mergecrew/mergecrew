import type { ReactNode } from 'react';
import { AppBar } from '@/components/app-bar';
import { UserMenu } from '@/components/user-menu';

export default async function OrgChromeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <>
      <AppBar orgSlug={slug} userMenu={<UserMenu currentOrgSlug={slug} />} />
      <div className="flex-1">{children}</div>
    </>
  );
}
