import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import {
  HealthBadge,
  LinkButton,
  PageHead,
  Chip,
  StatBadge,
  type HealthBadgeState,
} from '@/components/ui';
import { FirstRunEmptyState } from '@/components/first-run-empty-state';
import { relativeTime } from '@/lib/format';

interface ProjectHealth {
  projectId: string;
  projectSlug: string;
  worstState: HealthBadgeState;
  breachingSloNames: string[];
  atRiskSloNames: string[];
}

type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  demo?: boolean;
  archivedAt?: string | null;
  runsPausedAt?: string | null;
  createdAt?: string | null;
  lastRunAt?: string | null;
  connectedRepo?: {
    repoFullName: string;
    defaultBranch: string;
  } | null;
};

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const [projects, health] = await Promise.all([
    api<{ items: Project[] }>(`/v1/orgs/${slug}/projects`, { session }),
    api<{ items: ProjectHealth[] }>(`/v1/orgs/${slug}/projects-health`, {
      session,
    }).catch(() => ({ items: [] }) as { items: ProjectHealth[] }),
  ]);
  const items = projects.items ?? [];
  const healthBySlug = new Map(health.items.map((h) => [h.projectSlug, h]));

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Projects' },
        ]}
        title="Projects"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {items.length} project{items.length === 1 ? '' : 's'}
          </span>
        }
        actions={
          <LinkButton href={`/orgs/${slug}/projects/new`} variant="accent" size="sm">
            New project
          </LinkButton>
        }
      />

      {items.length === 0 ? (
        <FirstRunEmptyState orgSlug={slug} />
      ) : (
        <ul className="m-0 grid grid-cols-1 gap-4 list-none p-0 md:grid-cols-2">
          {items.map((p) => {
            const state = p.archivedAt
              ? 'archived'
              : p.runsPausedAt
                ? 'paused'
                : 'active';
            const h = healthBySlug.get(p.slug);
            const breachers = h?.breachingSloNames ?? [];
            const atRisks = h?.atRiskSloNames ?? [];
            const healthTooltip =
              breachers.length > 0
                ? `Breaching: ${breachers.join(', ')}`
                : atRisks.length > 0
                  ? `At risk: ${atRisks.join(', ')}`
                  : undefined;
            return (
              <li key={p.id}>
                <Link
                  href={`/orgs/${slug}/projects/${p.slug}`}
                  className="block h-full no-underline"
                >
                  <div className="flex h-full flex-col gap-3 border border-hair bg-paper p-5 transition-all hover:-translate-y-[2px] hover:border-accent hover:bg-paper-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[16px] font-medium tracking-[-0.005em] text-ink">
                            {p.name}
                          </span>
                          {p.demo && <Chip kind="medium">DEMO</Chip>}
                        </div>
                        <div className="mt-[2px] font-mono text-[11.5px] text-muted">/{p.slug}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <StatBadge
                          kind={
                            state === 'active'
                              ? 'healthy'
                              : state === 'paused'
                                ? 'warn'
                                : 'disabled'
                          }
                        >
                          {state}
                        </StatBadge>
                        {h && (
                          <HealthBadge
                            state={h.worstState}
                            tooltip={healthTooltip}
                            size="xs"
                          />
                        )}
                      </div>
                    </div>
                    {p.description && (
                      <p className="m-0 line-clamp-2 text-[13px] leading-[1.55] text-ink-2">
                        {p.description}
                      </p>
                    )}
                    {p.connectedRepo && (
                      <div className="font-mono text-[11.5px] text-muted">
                        {p.connectedRepo.repoFullName} · {p.connectedRepo.defaultBranch}
                      </div>
                    )}
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-hair-2 pt-3 font-mono text-[11px] text-muted">
                      <span>
                        {p.createdAt ? `created ${relativeTime(p.createdAt)}` : '—'}
                      </span>
                      <span>
                        {p.lastRunAt ? `last run ${relativeTime(p.lastRunAt)}` : 'no runs'}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
