import type { ReactNode } from 'react';

export default async function OrgLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col">{children}</div>;
}
