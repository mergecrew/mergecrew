import type { ReactNode } from 'react';
import { AppBar } from '@/components/app-bar';

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
      <AppBar orgSlug={slug} />
      <div className="flex-1">{children}</div>
    </>
  );
}
