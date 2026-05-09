import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card } from '@/components/ui';

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
    api<{ parsed: { agents?: Record<string, AgentRow> } }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/lifecycle`,
      { session },
    ),
    api<{ items: SkillRow[] }>(`/v1/skills`, { session }),
  ]);

  const agents = lc.parsed.agents ?? {};
  const skillsByName = new Map(catalog.items.map((s) => [s.name, s]));

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <h1 className="text-xl font-semibold">Agents</h1>
      <p className="text-sm text-zinc-500">
        {Object.keys(agents).length} agents configured for this project. Click any card to inspect
        its description and bound skills.
      </p>
      <ul className="space-y-2">
        {Object.entries(agents).map(([name, a]) => {
          const boundNames = (a.skills ?? []).map((s) => (typeof s === 'string' ? s : s.name));
          const guards = a.do_not_touch ?? [];
          return (
            <li key={name}>
              <Card>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-baseline justify-between">
                    <div>
                      <div className="font-medium">
                        {a.kind ?? name}
                        <span className="ml-2 inline-block text-zinc-400 transition group-open:rotate-90">
                          ›
                        </span>
                      </div>
                      <div className="text-sm text-zinc-500">/{name}</div>
                    </div>
                    <div className="font-mono text-xs text-zinc-500">
                      {boundNames.length} skills{guards.length ? ` · ${guards.length} guards` : ''}
                    </div>
                  </summary>
                  <div className="mt-4 space-y-4 border-t pt-4 dark:border-zinc-800">
                    <section>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Description
                      </h3>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
                        {a.description?.trim() || FALLBACK_DESCRIPTION}
                      </p>
                    </section>

                    {a.systemPrompt?.trim() && (
                      <section>
                        <details>
                          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                            Model prompt
                          </summary>
                          <pre className="mt-2 whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                            {a.systemPrompt}
                          </pre>
                        </details>
                      </section>
                    )}

                    <section>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Skills ({boundNames.length})
                      </h3>
                      {boundNames.length === 0 ? (
                        <p className="mt-1 text-sm italic text-zinc-500">No skills bound.</p>
                      ) : (
                        <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                          {boundNames.map((sn) => {
                            const def = skillsByName.get(sn);
                            return (
                              <li key={sn} className="py-2">
                                <div className="flex items-baseline justify-between gap-3">
                                  <span className="font-mono text-sm text-zinc-800 dark:text-zinc-100">
                                    {sn}
                                  </span>
                                  {def && (
                                    <SideEffectBadge cls={def.sideEffectClass} />
                                  )}
                                </div>
                                <div className="mt-0.5 text-xs text-zinc-500">
                                  {def
                                    ? def.description
                                    : 'Custom or unknown skill (not in stock catalog).'}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>

                    {(guards.length > 0 || a.model || a.maxStepsPerRun || a.maxToolCallsPerStep || a.budget) && (
                      <section>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Constraints
                        </h3>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          {a.model && (
                            <Row label="Model" value={a.model} />
                          )}
                          {a.maxStepsPerRun !== undefined && (
                            <Row label="Max steps / run" value={String(a.maxStepsPerRun)} />
                          )}
                          {a.maxToolCallsPerStep !== undefined && (
                            <Row label="Max tool calls / step" value={String(a.maxToolCallsPerStep)} />
                          )}
                          {a.budget?.tokens !== undefined && (
                            <Row label="Token budget" value={a.budget.tokens.toLocaleString()} />
                          )}
                          {a.budget?.usd !== undefined && (
                            <Row label="USD budget" value={`$${a.budget.usd.toFixed(2)}`} />
                          )}
                          {guards.length > 0 && (
                            <div className="col-span-2 pt-1">
                              <div className="text-zinc-500">Do-not-touch patterns</div>
                              <ul className="mt-0.5 space-y-0.5">
                                {guards.map((g) => (
                                  <li key={g} className="font-mono text-zinc-700 dark:text-zinc-300">
                                    {g}
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
    read: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    write_workspace: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    write_external: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    irreversible: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  }[cls];
  const label = cls.replace(/_/g, ' ');
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${tone}`}>
      {label}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-mono text-zinc-800 dark:text-zinc-100">{value}</dd>
    </>
  );
}
