import type { ReactNode } from 'react';
import Link from 'next/link';
import { Wordmark } from '@/components/ui';

export function TopBar({
  orgSlug,
  orgName,
  projectSlug,
  projectName,
  demoMode,
  userMenu,
}: {
  orgSlug: string;
  orgName?: string;
  projectSlug?: string;
  projectName?: string;
  demoMode?: boolean;
  userMenu?: ReactNode;
}) {
  const label = orgName ?? orgSlug;
  const initial = label.slice(0, 1).toUpperCase();
  return (
    <header className="sticky top-0 z-50 flex h-[56px] items-center justify-between border-b border-hair bg-paper px-[22px]">
      <div className="flex min-w-0 items-center gap-[18px]">
        <Wordmark withTag={false} href={`/orgs/${orgSlug}`} />
        <span className="h-[22px] w-px bg-hair" />
        <Link
          href={`/orgs/${orgSlug}`}
          className="flex items-center gap-2 rounded-md border border-transparent px-[10px] py-[6px] no-underline text-ink hover:border-hair hover:bg-bg"
        >
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-sm bg-accent font-mono text-[11px] font-semibold text-paper">
            {initial}
          </span>
          <span className="whitespace-nowrap text-[13.5px] font-medium">{label}</span>
          {projectSlug && (
            <span className="ml-1 whitespace-nowrap border-l border-hair pl-[6px] font-mono text-[11px] text-muted">
              {projectName ?? projectSlug}
            </span>
          )}
          <span className="ml-1 text-muted">▾</span>
        </Link>
        {demoMode && (
          <span className="inline-flex items-center gap-2 rounded-sm bg-energy-soft px-[10px] py-[5px] font-mono text-[11px] font-medium tracking-[0.04em] text-energy-deep">
            <span className="h-[6px] w-[6px] rounded-full bg-energy" />
            DEMO MODE · zero LLM keys
          </span>
        )}
      </div>
      <div className="flex items-center gap-[14px]">
        {userMenu}
      </div>
    </header>
  );
}
