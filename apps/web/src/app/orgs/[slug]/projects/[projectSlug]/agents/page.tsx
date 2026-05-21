import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Label, PageHead, Tile } from '@/components/ui';

interface SkillRow {
  name: string;
  description: string;
  sideEffectClass: 'read' | 'write_workspace' | 'write_external' | 'irreversible';
  capabilities?: string[];
}

interface AgentRow {
  kind?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  skills?: Array<string | { name: string; config?: unknown }>;
  do_not_touch?: string[];
  maxStepsPerRun?: number;
  maxToolCallsPerStep?: number;
  budget?: { tokens?: number; usd?: number };
  fallback?: string[];
}

const FALLBACK_DESCRIPTION =
  'No description set. The runtime default system prompt applies: receive a task, plan it, execute via bound skills, ground decisions in the repository state.';

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const [lc, catalog] = await Promise.all([
    apiOr404<{ parsed: { agents?: Record<string, AgentRow> } }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle`,
      { session },
    ),
    api<{ items: SkillRow[] }>(`/v1/skills`, { session }),
  ]);

  const agents = lc.parsed.agents ?? {};
  const skillsByName = new Map(catalog.items.map((s) => [s.name, s]));
  const agentEntries = Object.entries(agents);
  const totalSkills = agentEntries.reduce(
    (sum, [, a]) => sum + (a.skills?.length ?? 0),
    0,
  );
  const totalGuards = agentEntries.reduce(
    (sum, [, a]) => sum + (a.do_not_touch?.length ?? 0),
    0,
  );
  const distinctModels = new Set(
    agentEntries.map(([, a]) => a.model).filter((m): m is string => !!m),
  );

  return (
    <main className="mx-auto max-w-[1280px] px-9 py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          { label: 'Agents' },
        ]}
        title="Agents"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {agentEntries.length} agents · {totalSkills} skills bound
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Agents" v={String(agentEntries.length)} />
        <Tile k="Skills bound" v={String(totalSkills)} accent />
        <Tile k="Guards" v={String(totalGuards)} energy={totalGuards > 0} />
        <Tile k="Models" v={String(distinctModels.size)} />
      </section>

      <ul className="m-0 space-y-3 list-none p-0">
        {agentEntries.map(([name, a], i) => {
          const boundNames = (a.skills ?? []).map((s) =>
            typeof s === 'string' ? s : s.name,
          );
          const guards = a.do_not_touch ?? [];
          return (
            <li key={name}>
              <Card>
                <details className="group" open={i === 1}>
                  <summary className="grid cursor-pointer list-none grid-cols-[48px_1fr_auto] items-center gap-4 px-5 py-4">
                    <div className="flex h-[48px] w-[48px] items-center justify-center border-[1.5px] border-ink bg-paper-2 font-mono text-[24px] text-ink">
                      {(a.kind ?? name)[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium tracking-[-0.015em]">
                        {a.kind ?? name}
                        <span className="ml-2 inline-block text-muted transition group-open:rotate-90">
                          ›
                        </span>
                      </div>
                      <div className="mt-[2px] font-mono text-[11.5px] text-muted">/{name}</div>
                    </div>
                    <div className="font-mono text-[11.5px] text-muted whitespace-nowrap">
                      {boundNames.length} skills
                      {guards.length ? ` · ${guards.length} guards` : ''}
                    </div>
                  </summary>
                  <div className="space-y-5 border-t border-hair-2 px-5 py-5">
                    <section>
                      <Label className="block mb-2">Description</Label>
                      <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[1.6] text-ink-2">
                        {a.description?.trim() || FALLBACK_DESCRIPTION}
                      </p>
                    </section>

                    {a.systemPrompt?.trim() && (
                      <section>
                        <details>
                          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink">
                            System prompt
                          </summary>
                          <pre className="mt-2 whitespace-pre-wrap border-l-[3px] border-accent bg-bg-2 p-3 font-mono text-[12px] leading-[1.55] text-ink-2">
                            {a.systemPrompt}
                          </pre>
                        </details>
                      </section>
                    )}

                    <section>
                      <Label className="block mb-2">Skills ({boundNames.length})</Label>
                      {boundNames.length === 0 ? (
                        <p className="m-0 text-[13px] italic text-muted">No skills bound.</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          {boundNames.map((sn) => {
                            const def = skillsByName.get(sn);
                            return (
                              <div
                                key={sn}
                                className="border border-hair-2 bg-paper-2 p-3"
                              >
                                <div className="flex items-baseline justify-between gap-3">
                                  <span className="font-mono text-[12.5px] text-ink">{sn}</span>
                                  {def && <SideEffectBadge cls={def.sideEffectClass} />}
                                </div>
                                <div className="mt-1 text-[12px] text-muted">
                                  {def
                                    ? def.description
                                    : 'Custom or unknown skill (not in stock catalog).'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    {(guards.length > 0 ||
                      a.model ||
                      a.maxStepsPerRun ||
                      a.maxToolCallsPerStep ||
                      a.budget) && (
                      <section>
                        <Label className="block mb-2">Constraints</Label>
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
                          {a.model && <Row label="Model" value={a.model} />}
                          {a.maxStepsPerRun !== undefined && (
                            <Row label="Max steps / run" value={String(a.maxStepsPerRun)} />
                          )}
                          {a.maxToolCallsPerStep !== undefined && (
                            <Row
                              label="Max tool calls / step"
                              value={String(a.maxToolCallsPerStep)}
                            />
                          )}
                          {a.budget?.tokens !== undefined && (
                            <Row label="Token budget" value={a.budget.tokens.toLocaleString()} />
                          )}
                          {a.budget?.usd !== undefined && (
                            <Row label="USD budget" value={`$${a.budget.usd.toFixed(2)}`} />
                          )}
                          {guards.length > 0 && (
                            <div className="col-span-2 pt-2">
                              <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                                Do-not-touch patterns
                              </div>
                              <ul className="mt-2 flex flex-wrap gap-2 m-0 list-none p-0">
                                {guards.map((g) => (
                                  <li
                                    key={g}
                                    className="bg-energy-soft px-[8px] py-[3px] font-mono text-[11px] text-energy-deep"
                                  >
                                    ⊘ {g}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </dl>
                      </section>
                    )}
                  </div>
                </details>
              </Card>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function SideEffectBadge({ cls }: { cls: SkillRow['sideEffectClass'] }) {
  const tone = {
    read: 'bg-bg text-ink-2 border border-hair',
    write_workspace: 'bg-accent-soft text-accent-deep border border-accent',
    write_external: 'bg-warn/20 text-ink border border-warn',
    irreversible: 'bg-energy-soft text-energy-deep border border-energy',
  }[cls];
  const label = cls.replace(/_/g, ' ');
  return (
    <span
      className={`shrink-0 px-[8px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${tone}`}
    >
      {label}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 font-mono text-ink">{value}</dd>
    </>
  );
}
