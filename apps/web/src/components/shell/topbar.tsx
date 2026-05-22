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
    <header className="sticky top-0 z-50 flex h-[56px] items-center justify-between gap-2 border-b border-hair bg-paper px-[14px] md:px-[22px]">
      <div className="flex min-w-0 items-center gap-[10px] md:gap-[18px]">
        {/* Full wordmark on md+; on mobile the hamburger in AppShell
            doubles as the brand mark, so we hide the wordmark to free
            up room for the org switcher. */}
        <div className="hidden md:flex">
          <Wordmark withTag={false} href={`/orgs/${orgSlug}`} />
        </div>
        <span className="hidden h-[22px] w-px bg-hair md:block" />
        <Link
          href={`/orgs/${orgSlug}`}
          className="flex min-w-0 items-center gap-2 rounded-md border border-transparent px-[8px] py-[6px] no-underline text-ink hover:border-hair hover:bg-bg md:px-[10px]"
        >
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-sm bg-accent font-mono text-[11px] font-semibold text-paper">
            {initial}
          </span>
          <span className="truncate text-[13.5px] font-medium">{label}</span>
          {projectSlug && (
            <span className="hidden whitespace-nowrap border-l border-hair pl-[6px] font-mono text-[11px] text-muted md:inline">
              {projectName ?? projectSlug}
            </span>
          )}
          <span className="ml-1 flex-shrink-0 text-muted">▾</span>
        </Link>
        {demoMode && (
          <span className="hidden items-center gap-2 rounded-sm bg-energy-soft px-[10px] py-[5px] font-mono text-[11px] font-medium tracking-[0.04em] text-energy-deep md:inline-flex">
            <span className="h-[6px] w-[6px] rounded-full bg-energy" />
            DEMO MODE · zero LLM keys
          </span>
        )}
        {/* Compact demo dot on mobile so the warning is still visible
            without taking up the whole bar. */}
        {demoMode && (
          <span
            className="inline-flex h-[10px] w-[10px] flex-shrink-0 items-center justify-center rounded-full bg-energy md:hidden"
            title="Demo mode — zero LLM keys"
            aria-label="Demo mode"
          />
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-[14px]">{userMenu}</div>
    </header>
  );
}
