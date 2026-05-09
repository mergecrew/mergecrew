'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

const ORG_ITEMS = [
  { href: '', label: 'Today' },
  { href: 'projects', label: 'Projects' },
  { href: 'inbox', label: 'Inbox' },
  { href: 'activity', label: 'Activity' },
  { href: 'costs', label: 'Costs' },
  { href: 'lifecycle-templates', label: 'Templates' },
  { href: 'settings', label: 'Settings' },
];

const PROJECT_ITEMS = [
  { href: '', label: 'Overview' },
  { href: 'timeline', label: 'Timeline' },
  { href: 'lifecycle', label: 'Lifecycle' },
  { href: 'agents', label: 'Agents' },
  { href: 'changesets', label: 'Changesets' },
  { href: 'digest', label: 'Digest' },
  { href: 'settings', label: 'Settings' },
];

export function AppBar({
  orgSlug,
  project,
  userMenu,
}: {
  orgSlug: string;
  project?: { slug: string; name: string };
  userMenu?: ReactNode;
}) {
  const pathname = usePathname();
  const inProject = !!project;
  const items = inProject ? PROJECT_ITEMS : ORG_ITEMS;
  const base = inProject ? `/orgs/${orgSlug}/projects/${project!.slug}` : `/orgs/${orgSlug}`;

  return (
    <nav className="flex flex-wrap items-center gap-1 border-b px-4 py-2 text-sm">
      {inProject && (
        <Link
          href={`/orgs/${orgSlug}`}
          className="flex items-center rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Back to organization"
        >
          <ArrowLeft size={14} />
        </Link>
      )}
      <Link href={`/orgs/${orgSlug}`} className="font-semibold hover:opacity-80">
        Mergecrew
      </Link>
      <span className="text-zinc-400">·</span>
      <Link
        href={`/orgs/${orgSlug}`}
        className="rounded px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {orgSlug}
      </Link>
      {inProject && (
        <>
          <ChevronRight size={12} className="text-zinc-400" />
          <span className="font-medium" title={`/${project!.slug}`}>
            {project!.name}
          </span>
        </>
      )}
      <span className="mx-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
      {items.map((it) => {
        const href = it.href ? `${base}/${it.href}` : base;
        const active = it.href ? pathname.startsWith(href) : pathname === base;
        return (
          <Link
            key={it.label}
            href={href}
            className={clsx(
              'rounded px-2 py-1',
              active
                ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
            )}
          >
            {it.label}
          </Link>
        );
      })}
      {userMenu && <div className="ml-auto">{userMenu}</div>}
    </nav>
  );
}
