import type { ReactNode } from 'react';
import { DemoModeBanner } from '@/components/demo-mode-banner';

export default async function OrgLayout({ children }: { children: ReactNode }) {
  // Server reads MERGECREW_DEMO_MODE once per render. The runner reads
  // the same env on dispatch — if a self-host operator flips the env
  // mid-session, both sides converge on a redeploy. The banner only
  // mounts when demo mode is active, so production deployments never
  // ship the markup.
  const demoMode = process.env.MERGECREW_DEMO_MODE === '1';
  return (
    <div className="flex min-h-screen flex-col">
      {demoMode && <DemoModeBanner />}
      {children}
    </div>
  );
}
