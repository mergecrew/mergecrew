'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';

type Item = { label: string; href: string; count?: string; livePending?: boolean };
type Group = { label: string; items: Item[] };

// Active item = longest href that the current path matches. Falling
// back to plain `startsWith(href + '/')` would mark *every* parent
// link active for nested routes (Today + Runs both highlight when the
// user is on /runs/abc123), which is the bug fixed by #706.
function isActive(pathname: string | null, href: string, allHrefs: string[]): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  if (href === '/' || !pathname.startsWith(href + '/')) return false;
  for (const other of allHrefs) {
    if (other === href) continue;
    if (
      other.length > href.length &&
      other.startsWith(href) &&
      (pathname === other || pathname.startsWith(other + '/'))
    ) {
      return false;
    }
  }
  return true;
}

function NavItem({
  item,
  allHrefs,
}: {
  item: Item;
  allHrefs: string[];
}) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href, allHrefs);
  return (
    <Link
      href={item.href}
      className={clsx(
        'flex items-center gap-[10px] rounded-md border px-[10px] py-[8px] text-[13.5px] font-medium no-underline',
        'transition-colors duration-100',
        active
          ? 'border-accent-soft bg-accent-tint text-accent-deep'
          : 'border-transparent text-ink-2 hover:bg-bg',
      )}
    >
      <span
        className={clsx(
          'h-[14px] w-[14px] flex-shrink-0 border-[1.5px]',
          active ? 'border-accent bg-accent' : 'border-current opacity-60',
        )}
      />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {item.label}
      </span>
      {item.count && (
        <span
          className={clsx(
            'ml-auto rounded-[8px] px-[6px] py-[1px] font-mono text-[10.5px]',
            active ? 'bg-accent text-paper' : 'bg-bg text-muted',
          )}
        >
          {item.count}
        </span>
      )}
      {item.livePending && (
        <span className="ml-auto h-[6px] w-[6px] rounded-full bg-energy animate-pulse-energy" />
      )}
    </Link>
  );
}

function GroupRender({ group, allHrefs }: { group: Group; allHrefs: string[] }) {
  return (
    <div>
      <div className="px-[10px] pt-[14px] pb-[6px] font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
        {group.label}
      </div>
      {group.items.map((it) => (
        <NavItem key={it.href} item={it} allHrefs={allHrefs} />
      ))}
    </div>
  );
}

function allHrefsOf(groups: Group[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

export function OrgSidebar({
  orgSlug,
  orgName,
  projectCount,
  mtdSpend,
  monthlyCap,
}: {
  orgSlug: string;
  orgName?: string;
  projectCount?: number;
  mtdSpend?: string;
  monthlyCap?: string;
}) {
  const base = `/orgs/${orgSlug}`;
  const groups: Group[] = [
    {
      label: 'Workspace',
      items: [
        { label: 'Overview', href: base },
        {
          label: 'Projects',
          href: `${base}/projects`,
          count: projectCount != null ? String(projectCount) : undefined,
        },
        { label: 'Inbox', href: `${base}/inbox` },
        { label: 'Activity', href: `${base}/activity` },
      ],
    },
    {
      label: 'Operations',
      items: [
        { label: 'Costs', href: `${base}/costs` },
        { label: 'Evals', href: `${base}/evals` },
      ],
    },
    {
      label: 'Library',
      items: [
        { label: 'Lifecycle templates', href: `${base}/lifecycle-templates` },
        { label: 'Skill catalog', href: `${base}/skills` },
      ],
    },
    {
      label: 'Config',
      items: [{ label: 'Org settings', href: `${base}/settings` }],
    },
  ];
  const allHrefs = allHrefsOf(groups);
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-[22px_14px]">
      <div className="mb-[6px] border-b border-hair-2 pb-[14px]">
        <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
          Organisation
        </div>
        <div className="mt-1 text-[15.5px] font-semibold tracking-[-0.015em]">
          {orgName ?? orgSlug}
        </div>
        {projectCount != null && (
          <div className="mt-[6px] flex items-center gap-2 font-mono text-[10.5px] text-muted whitespace-nowrap">
            <span className="h-[6px] w-[6px] rounded-full bg-positive animate-live-pulse" />
            <span>
              {projectCount} project{projectCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>
      {groups.map((g) => (
        <GroupRender key={g.label} group={g} allHrefs={allHrefs} />
      ))}
      {mtdSpend && (
        <div className="mt-auto border-t border-hair-2 pt-[12px] px-[10px]">
          <div className="font-mono text-[10.5px] text-muted">
            MTD spend · <b className="text-ink">{mtdSpend}</b>
          </div>
          {monthlyCap && (
            <div className="mt-[6px] text-[12px] text-ink-2">of {monthlyCap} monthly cap</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectSidebar({
  orgSlug,
  projectSlug,
  projectName,
  status = 'running',
  awaitingApproval,
}: {
  orgSlug: string;
  projectSlug: string;
  projectName?: string;
  status?: 'running' | 'paused' | 'failed';
  awaitingApproval?: boolean;
}) {
  const base = `/orgs/${orgSlug}/projects/${projectSlug}`;
  const groups: Group[] = [
    {
      label: 'Workspace',
      items: [
        { label: 'Today', href: base },
        { label: 'Runs', href: `${base}/runs` },
        { label: 'Changesets', href: `${base}/changesets` },
        { label: 'Digests', href: `${base}/digest`, livePending: awaitingApproval },
        { label: 'Scan reports', href: `${base}/scans` },
      ],
    },
    {
      label: 'Agents',
      items: [
        { label: 'Agents', href: `${base}/agents` },
        { label: 'Lifecycle', href: `${base}/lifecycle` },
      ],
    },
    {
      label: 'Config',
      items: [{ label: 'Project settings', href: `${base}/settings` }],
    },
  ];
  const allHrefs = allHrefsOf(groups);
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-[22px_14px]">
      <div className="mb-[6px] border-b border-hair-2 pb-[14px]">
        <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
          Project · {orgSlug}
        </div>
        <div className="mt-1 text-[15.5px] font-semibold tracking-[-0.015em]">
          {projectName ?? projectSlug}
        </div>
        <div className="mt-[6px] flex items-center gap-2 font-mono text-[10.5px] text-muted whitespace-nowrap">
          <span
            className={clsx(
              'h-[6px] w-[6px] rounded-full',
              status === 'running' && 'bg-positive animate-live-pulse',
              status === 'paused' && 'bg-warn',
              status === 'failed' && 'bg-energy',
            )}
          />
          <span>{status}</span>
        </div>
      </div>
      {groups.map((g) => (
        <GroupRender key={g.label} group={g} allHrefs={allHrefs} />
      ))}
    </div>
  );
}
