import type { ReactNode } from 'react';

export default async function OrgLayout({ children }: { children: ReactNode }) {
  // The redesigned shell surfaces the demo-mode indicator as a
  // persistent pill inside the TopBar (see `(org)/layout.tsx` and
  // project layout). The previous full-width DemoModeBanner was
  // dismissible — the pill is always-visible, which is safer for an
  // operator who set MERGECREW_DEMO_MODE=1 on purpose.
  return <>{children}</>;
}
