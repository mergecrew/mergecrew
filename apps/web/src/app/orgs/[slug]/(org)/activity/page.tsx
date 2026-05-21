import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead } from '@/components/ui';
import { relativeTime } from '@/lib/format';

type ActivityEvent = {
  id: string;
  type: string;
  occurredAt: string;
  projectId?: string | null;
  projectSlug?: string | null;
  payload?: Record<string, any>;
};

function eventKind(type: string): 'run' | 'gate' | 'deploy' | 'changeset' | 'other' {
  if (
    type.startsWith('RUN_') ||
    type === 'WORKFLOW_STARTED' ||
    type === 'AGENT_STEP_FINISHED'
  ) {
    return 'run';
  }
  if (
    type === 'APPROVAL_REQUESTED' ||
    type === 'APPROVAL_RESOLVED' ||
    type === 'CHANGESET_PROMOTED'
  ) {
    return 'gate';
  }
  if (type === 'DEPLOY_DISPATCHED' || type === 'DEPLOY_FINISHED') return 'deploy';
  if (type.includes('CHANGESET')) return 'changeset';
  return 'other';
}

const KIND_TONES: Record<ReturnType<typeof eventKind>, string> = {
  run: 'bg-accent-soft text-accent-deep',
  gate: 'bg-energy-soft text-energy-deep',
  deploy: 'bg-positive-soft text-positive-deep',
  changeset: 'bg-accent-tint text-accent-deep',
  other: 'bg-bg text-ink-2 border border-hair',
};

function summary(e: ActivityEvent): string {
  const p = e.payload ?? {};
  if (e.type === 'AGENT_TOOL_CALL') return `${p.name}${p.brief ? ' — ' + p.brief : ''}`;
  if (e.type === 'CHANGESET_PROMOTED') return `promoted ${p.changesetId}`;
  if (e.type === 'CHANGESET_AUTO_PROMOTED')
    return `auto-promoted via "${p.ruleName}" (PR #${p.prNumber})`;
  if (e.type === 'WORKFLOW_STARTED') return `workflow ${p.workflowId}`;
  try {
    return JSON.stringify(p).slice(0, 200);
  } catch {
    return '';
  }
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const events = await api<{ items: ActivityEvent[] }>(
    `/v1/orgs/${slug}/activity?limit=200`,
    { session },
  );
  const items = events.items ?? [];

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Activity' },
        ]}
        title="Activity"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            most recent {items.length} events
          </span>
        }
      />

      <Card>
        {items.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">No events yet.</div>
        ) : (
          <ul className="m-0 list-none p-0">
            <li className="hidden border-b border-ink px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted md:grid md:grid-cols-[170px_90px_200px_110px_1fr] md:gap-4">
              <span>When</span>
              <span>Kind</span>
              <span>Event</span>
              <span>Project</span>
              <span>Detail</span>
            </li>
            {items.map((e, i) => {
              const kind = eventKind(e.type);
              return (
                <li
                  key={e.id}
                  className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
                >
                  <div className="grid grid-cols-1 items-center gap-2 px-5 py-3 text-[13px] md:grid-cols-[170px_90px_200px_110px_1fr] md:gap-4">
                    <span className="font-mono text-[11.5px] text-muted">
                      {relativeTime(e.occurredAt)}
                    </span>
                    <span
                      className={`inline-block px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${KIND_TONES[kind]}`}
                    >
                      {kind}
                    </span>
                    <span className="bg-accent-tint px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-deep">
                      {e.type}
                    </span>
                    <span className="font-mono text-[11.5px] text-muted">
                      {e.projectSlug ?? '—'}
                    </span>
                    <span className="truncate text-[12.5px] text-ink-2">{summary(e)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}
