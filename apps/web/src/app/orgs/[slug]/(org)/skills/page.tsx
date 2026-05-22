import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead, Tile } from '@/components/ui';

type SkillRow = {
  name: string;
  description: string;
  sideEffectClass: 'read' | 'write_workspace' | 'write_external' | 'irreversible';
  capabilities?: string[];
};

const SIDE_EFFECT_TONES: Record<SkillRow['sideEffectClass'], string> = {
  read: 'bg-bg text-ink-2 border border-hair',
  write_workspace: 'bg-accent-soft text-accent-deep border border-accent',
  write_external: 'bg-warn/30 text-ink border border-warn',
  irreversible: 'bg-energy-soft text-energy-deep border border-energy',
};

function SideEffectBadge({ cls }: { cls: SkillRow['sideEffectClass'] }) {
  return (
    <span
      className={`shrink-0 px-[8px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${SIDE_EFFECT_TONES[cls]}`}
    >
      {cls.replace(/_/g, ' ')}
    </span>
  );
}

export default async function SkillsCatalogPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const catalog = await api<{ items: SkillRow[] }>('/v1/skills', { session }).catch(() => ({
    items: [] as SkillRow[],
  }));

  const items = catalog.items ?? [];
  const counts = items.reduce(
    (acc, s) => {
      acc.total += 1;
      acc[s.sideEffectClass] = (acc[s.sideEffectClass] ?? 0) + 1;
      return acc;
    },
    { total: 0 } as Record<string, number>,
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Skill catalog' },
        ]}
        title="Skill catalog"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Stock skills available to bind in any agent on any project. Side-effect class
            controls the guardrail tier.
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Total" v={String(counts.total)} />
        <Tile k="Read-only" v={String(counts.read ?? 0)} />
        <Tile k="Write workspace" v={String(counts.write_workspace ?? 0)} accent />
        <Tile
          k="Irreversible"
          v={String(counts.irreversible ?? 0)}
          energy={(counts.irreversible ?? 0) > 0}
        />
      </section>

      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">
            Skill catalog is empty for this deployment. Skills are loaded from{' '}
            <code className="font-mono text-[12px] text-ink">packages/skills</code> at boot.
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((s, i) => (
              <li key={s.name} className={i < items.length - 1 ? 'border-b border-hair-2' : ''}>
                <div className="grid grid-cols-[1fr_auto] items-start gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-[14px] font-medium text-ink">
                        {s.name}
                      </span>
                      {s.capabilities && s.capabilities.length > 0 && (
                        <span className="font-mono text-[10.5px] text-muted">
                          {s.capabilities.join(' · ')}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[12.5px] leading-[1.55] text-ink-2">
                      {s.description}
                    </div>
                  </div>
                  <SideEffectBadge cls={s.sideEffectClass} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
