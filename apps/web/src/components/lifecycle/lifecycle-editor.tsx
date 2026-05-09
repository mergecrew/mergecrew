'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  upsertAgentAction,
  deleteAgentAction,
  upsertWorkflowAction,
  deleteWorkflowAction,
  upsertCustomSkillAction,
  deleteCustomSkillAction,
  setHumanGatesAction,
  applyOrgTemplateAction,
} from './lifecycle-actions';
import type { LifecycleScope } from './scope';

interface AgentDef {
  kind: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  fallback: string[];
  skills: Array<string | { name: string; config?: unknown }>;
  do_not_touch: string[];
  maxStepsPerRun: number;
  maxToolCallsPerStep: number;
  budget?: { tokens?: number; usd?: number };
}

interface WorkflowDef {
  id: string;
  description?: string;
  agents: string[];
  out: string[];
  transitions: { to: string; when: string; gate: 'auto' | 'notify' | 'require-approval' }[];
}

interface CustomSkillDef {
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  endpoint?: string;
  authRef?: string;
  sideEffectClass: 'read' | 'write_workspace' | 'write_external' | 'irreversible';
}

interface HumanGatesDef {
  production_promote: 'auto' | 'notify' | 'require-approval';
  sensitive_path_patterns: string[];
}

export interface ParsedConfig {
  version: number;
  lifecycle: {
    workflows: WorkflowDef[];
    human_gates?: HumanGatesDef;
  };
  agents: Record<string, AgentDef>;
  skills: Record<string, CustomSkillDef>;
}

interface SkillCatalogEntry {
  name: string;
  description: string;
  sideEffectClass: string;
}

type Tab = 'workflows' | 'agents' | 'skills' | 'gates' | 'source';

export function LifecycleEditor({
  scope,
  parsed,
  sourceYaml,
  catalog,
  showApplyTemplate = false,
}: {
  scope: LifecycleScope;
  parsed: ParsedConfig;
  sourceYaml: string;
  catalog: SkillCatalogEntry[];
  showApplyTemplate?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('agents');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const wrap = (run: () => Promise<unknown>, successText?: string) => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      try {
        await run();
        if (successText) setInfo(successText);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b pb-2 dark:border-zinc-800">
        {(['agents', 'workflows', 'skills', 'gates', 'source'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'rounded px-3 py-1 text-sm capitalize transition ' +
              (tab === t
                ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')
            }
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-500">v{parsed.version ?? 1}</span>
        {showApplyTemplate && scope.kind === 'project' && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              wrap(() => applyOrgTemplateAction(scope, 'default'), 'Org default template applied as a new lifecycle version.')
            }
          >
            Apply org default template
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}
      {info && (
        <div className="rounded bg-green-50 p-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300">
          {info}
        </div>
      )}

      {tab === 'agents' && (
        <AgentsTab
          scope={scope}
          agents={parsed.agents}
          catalog={catalog}
          customSkills={Object.keys(parsed.skills ?? {})}
          pending={pending}
          wrap={wrap}
        />
      )}
      {tab === 'workflows' && (
        <WorkflowsTab
          scope={scope}
          workflows={parsed.lifecycle.workflows}
          agents={Object.keys(parsed.agents ?? {})}
          pending={pending}
          wrap={wrap}
        />
      )}
      {tab === 'skills' && (
        <SkillsTab
          scope={scope}
          skills={parsed.skills}
          catalog={catalog}
          pending={pending}
          wrap={wrap}
        />
      )}
      {tab === 'gates' && (
        <GatesTab
          scope={scope}
          gates={parsed.lifecycle.human_gates}
          pending={pending}
          wrap={wrap}
        />
      )}
      {tab === 'source' && (
        <pre className="overflow-x-auto rounded border bg-zinc-50 p-3 text-xs dark:bg-zinc-900 dark:border-zinc-800">
          {sourceYaml || '(no source YAML stored — configuration is structured-only)'}
        </pre>
      )}
    </div>
  );
}

// ─────────────── Agents tab ───────────────

function AgentsTab({
  scope,
  agents,
  catalog,
  customSkills,
  pending,
  wrap,
}: {
  scope: LifecycleScope;
  agents: Record<string, AgentDef>;
  catalog: SkillCatalogEntry[];
  customSkills: string[];
  pending: boolean;
  wrap: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const allSkillNames = [...catalog.map((s) => s.name), ...customSkills].sort();

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-zinc-500">
          {Object.keys(agents).length} agents. Each agent is bound to a set of skills and runs as
          part of a workflow.
        </p>
        <Button onClick={() => { setCreating(true); setEditing(null); }} variant="primary" disabled={pending}>
          New agent
        </Button>
      </div>

      {creating && (
        <AgentForm
          mode="create"
          allSkillNames={allSkillNames}
          onSubmit={(ref, def) =>
            wrap(async () => {
              await upsertAgentAction(scope, ref, def);
              setCreating(false);
            }, `Agent "${ref}" created.`)
          }
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-2">
        {Object.entries(agents).map(([ref, a]) => (
          <li key={ref} className="rounded border p-3 dark:border-zinc-800">
            {editing === ref ? (
              <AgentForm
                mode="edit"
                ref0={ref}
                initial={a}
                allSkillNames={allSkillNames}
                onSubmit={(_, def) =>
                  wrap(async () => {
                    await upsertAgentAction(scope, ref, def);
                    setEditing(null);
                  }, `Agent "${ref}" saved.`)
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div>
                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="font-medium">{a.kind}</div>
                    <div className="text-xs text-zinc-500">/{ref} · {(a.skills ?? []).length} skill(s)</div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(ref)} variant="secondary" disabled={pending}>Edit</Button>
                    <Button
                      onClick={() => {
                        if (!confirm(`Delete agent "${ref}"? It will also be removed from any workflow.`)) return;
                        wrap(() => deleteAgentAction(scope, ref), `Agent "${ref}" deleted.`);
                      }}
                      variant="secondary"
                      disabled={pending}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {a.description && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{a.description}</p>
                )}
                {a.systemPrompt && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                      Model prompt
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">{a.systemPrompt}</p>
                  </details>
                )}
                {(a.skills ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(a.skills ?? []).map((s, i) => {
                      const name = typeof s === 'string' ? s : s.name;
                      return (
                        <span key={i} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800">
                          {name}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentForm({
  mode,
  ref0,
  initial,
  allSkillNames,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  ref0?: string;
  initial?: AgentDef;
  allSkillNames: string[];
  onSubmit: (ref: string, def: AgentDef) => void;
  onCancel: () => void;
}) {
  const [ref, setRef] = useState(ref0 ?? '');
  const [kind, setKind] = useState(initial?.kind ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [fallback, setFallback] = useState((initial?.fallback ?? []).join('\n'));
  const initialSkills = (initial?.skills ?? []).map((s) => (typeof s === 'string' ? s : s.name));
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSkills));
  const [doNotTouch, setDoNotTouch] = useState((initial?.do_not_touch ?? []).join('\n'));
  const [maxStepsPerRun, setMaxStepsPerRun] = useState(initial?.maxStepsPerRun ?? 12);
  const [maxToolCallsPerStep, setMaxToolCallsPerStep] = useState(initial?.maxToolCallsPerStep ?? 8);
  const [tokens, setTokens] = useState(initial?.budget?.tokens ?? '');
  const [usd, setUsd] = useState(initial?.budget?.usd ?? '');

  const submit = () => {
    if (mode === 'create' && !/^[a-z0-9_]+$/.test(ref)) {
      alert('Agent ref must be lowercase a-z, 0-9, _');
      return;
    }
    if (!kind.trim()) {
      alert('Agent kind is required.');
      return;
    }
    const def: AgentDef = {
      kind: kind.trim(),
      description: description.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      model: model.trim() || undefined,
      fallback: fallback.split('\n').map((l) => l.trim()).filter(Boolean),
      skills: Array.from(selected),
      do_not_touch: doNotTouch.split('\n').map((l) => l.trim()).filter(Boolean),
      maxStepsPerRun: Number(maxStepsPerRun) || 12,
      maxToolCallsPerStep: Number(maxToolCallsPerStep) || 8,
      budget:
        tokens || usd
          ? {
              ...(tokens ? { tokens: Number(tokens) } : {}),
              ...(usd ? { usd: Number(usd) } : {}),
            }
          : undefined,
    };
    onSubmit(ref, def);
  };

  const toggleSkill = (n: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">
            Ref (lowercase identifier){mode === 'edit' && ' — read-only'}
          </span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="e.g. backend_engineer"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            readOnly={mode === 'edit'}
          />
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Kind (display name)</span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="e.g. BackendEngineer"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Description{' '}
          <span className="text-xs text-zinc-400">— one paragraph, shown to humans browsing the project</span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          rows={3}
          placeholder="What this agent does and the value it produces. Distinct from the model prompt below."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          System prompt (optional){' '}
          <span className="text-xs text-zinc-400">— sent to the model on every turn</span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          rows={4}
          placeholder="The rules the agent follows and the style of output expected."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Model override (optional, e.g. <code>provider-id/model-id</code>)
        </span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Fallbacks (optional, one <code>providerKind/modelId</code> per line)
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={3}
          placeholder="anthropic/claude-3-5-sonnet-20241022&#10;openai/gpt-4o-mini"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
        />
      </label>

      <div>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">Skills ({selected.size} selected)</span>
        <div className="mt-1 max-h-48 overflow-y-auto rounded border p-2 dark:border-zinc-800">
          {allSkillNames.length === 0 && <p className="text-xs text-zinc-500">No skills available.</p>}
          {allSkillNames.map((n) => (
            <label key={n} className="flex items-center gap-2 py-0.5 text-xs">
              <input type="checkbox" checked={selected.has(n)} onChange={() => toggleSkill(n)} />
              <span className="font-mono">{n}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Do-not-touch patterns (one per line, glob)
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          rows={3}
          placeholder="apps/*/src/auth/**"
          value={doNotTouch}
          onChange={(e) => setDoNotTouch(e.target.value)}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-4">
        <NumberField label="Max steps / run" value={maxStepsPerRun} onChange={setMaxStepsPerRun} />
        <NumberField label="Max tool calls / step" value={maxToolCallsPerStep} onChange={setMaxToolCallsPerStep} />
        <NumberField label="Token budget" value={tokens as any} onChange={setTokens as any} placeholder="(unlimited)" />
        <NumberField label="USD budget" value={usd as any} onChange={setUsd as any} placeholder="(unlimited)" step="0.01" />
      </div>

      <div className="flex gap-2">
        <Button onClick={submit} variant="primary">{mode === 'create' ? 'Create agent' : 'Save changes'}</Button>
        <Button onClick={onCancel} variant="secondary">Cancel</Button>
      </div>
    </div>
  );
}

function NumberField({
  label, value, onChange, placeholder, step,
}: { label: string; value: number | string; onChange: (v: any) => void; placeholder?: string; step?: string }) {
  return (
    <label className="block text-sm">
      <span className="block text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        type="number"
        step={step}
        className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
        value={value as any}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </label>
  );
}

// ─────────────── Workflows tab ───────────────

function WorkflowsTab({
  scope,
  workflows,
  agents,
  pending,
  wrap,
}: {
  scope: LifecycleScope;
  workflows: WorkflowDef[];
  agents: string[];
  pending: boolean;
  wrap: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const wfIds = workflows.map((w) => w.id);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-zinc-500">
          {workflows.length} workflows. Each runs the listed agents and transitions to others when its conditions match.
        </p>
        <Button onClick={() => { setCreating(true); setEditing(null); }} variant="primary" disabled={pending}>
          New workflow
        </Button>
      </div>

      {creating && (
        <WorkflowForm
          mode="create"
          allAgents={agents}
          allWorkflowIds={wfIds}
          onSubmit={(id, def) => wrap(async () => {
            await upsertWorkflowAction(scope, id, def);
            setCreating(false);
          }, `Workflow "${id}" created.`)}
          onCancel={() => setCreating(false)}
        />
      )}

      <ul className="space-y-2">
        {workflows.map((w) => (
          <li key={w.id} className="rounded border p-3 dark:border-zinc-800">
            {editing === w.id ? (
              <WorkflowForm
                mode="edit"
                initial={w}
                allAgents={agents}
                allWorkflowIds={wfIds}
                onSubmit={(_, def) => wrap(async () => {
                  await upsertWorkflowAction(scope, w.id, def);
                  setEditing(null);
                }, `Workflow "${w.id}" saved.`)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-mono font-medium">{w.id}</div>
                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(w.id)} variant="secondary" disabled={pending}>Edit</Button>
                    <Button
                      onClick={() => {
                        if (!confirm(`Delete workflow "${w.id}"? Other workflows pointing at it will be unlinked.`)) return;
                        wrap(() => deleteWorkflowAction(scope, w.id), `Workflow "${w.id}" deleted.`);
                      }}
                      variant="secondary"
                      disabled={pending}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {w.description && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{w.description}</p>
                )}
                <div className="mt-1 text-xs text-zinc-500">
                  agents: {w.agents.join(' · ') || '(none)'} · → {w.out.join(', ') || '(end)'}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowForm({
  mode, initial, allAgents, allWorkflowIds, onSubmit, onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: WorkflowDef;
  allAgents: string[];
  allWorkflowIds: string[];
  onSubmit: (id: string, def: WorkflowDef) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set(initial?.agents ?? []));
  const [outList, setOutList] = useState<Set<string>>(new Set(initial?.out ?? []));
  const [transitionsText, setTransitionsText] = useState(
    JSON.stringify(initial?.transitions ?? [], null, 2),
  );

  const submit = () => {
    if (mode === 'create' && !/^[a-z0-9_]+$/.test(id)) {
      alert('Workflow id must be lowercase a-z, 0-9, _');
      return;
    }
    let transitions: WorkflowDef['transitions'] = [];
    if (transitionsText.trim()) {
      try {
        transitions = JSON.parse(transitionsText);
      } catch (e: any) {
        alert(`transitions: invalid JSON — ${e?.message ?? e}`);
        return;
      }
    }
    onSubmit(id, {
      id,
      description: description.trim() || undefined,
      agents: Array.from(selectedAgents),
      out: Array.from(outList),
      transitions,
    });
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Workflow id{mode === 'edit' && ' — read-only'}
        </span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          value={id}
          onChange={(e) => setId(e.target.value)}
          readOnly={mode === 'edit'}
        />
      </label>

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Description{' '}
          <span className="text-xs text-zinc-400">— what this workflow produces</span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          rows={3}
          placeholder="One paragraph explaining what runs here and what it outputs."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <CheckboxList
        label={`Agents (${selectedAgents.size} selected)`}
        items={allAgents}
        selected={selectedAgents}
        onToggle={(n) =>
          setSelectedAgents((prev) => {
            const next = new Set(prev);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            return next;
          })
        }
        empty="No agents defined yet — create some on the Agents tab first."
      />

      <CheckboxList
        label={`Outgoing edges (${outList.size} selected)`}
        items={allWorkflowIds.filter((x) => x !== id)}
        selected={outList}
        onToggle={(n) =>
          setOutList((prev) => {
            const next = new Set(prev);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            return next;
          })
        }
        empty="No other workflows defined."
      />

      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Transitions (JSON array of {`{to, when, gate}`}, optional)
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          rows={5}
          value={transitionsText}
          onChange={(e) => setTransitionsText(e.target.value)}
        />
      </label>

      <div className="flex gap-2">
        <Button onClick={submit} variant="primary">{mode === 'create' ? 'Create workflow' : 'Save changes'}</Button>
        <Button onClick={onCancel} variant="secondary">Cancel</Button>
      </div>
    </div>
  );
}

function CheckboxList({
  label, items, selected, onToggle, empty,
}: { label: string; items: string[]; selected: Set<string>; onToggle: (n: string) => void; empty: string }) {
  return (
    <div>
      <span className="text-sm text-zinc-600 dark:text-zinc-400">{label}</span>
      <div className="mt-1 max-h-40 overflow-y-auto rounded border p-2 dark:border-zinc-800">
        {items.length === 0 && <p className="text-xs text-zinc-500">{empty}</p>}
        {items.map((n) => (
          <label key={n} className="flex items-center gap-2 py-0.5 text-xs">
            <input type="checkbox" checked={selected.has(n)} onChange={() => onToggle(n)} />
            <span className="font-mono">{n}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─────────────── Skills tab ───────────────

function SkillsTab({
  scope, skills, catalog, pending, wrap,
}: {
  scope: LifecycleScope;
  skills: Record<string, CustomSkillDef>;
  catalog: SkillCatalogEntry[];
  pending: boolean;
  wrap: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-zinc-500">
            Stock skills from the runtime ({catalog.length}). Read-only — bundled with the deployment.
          </p>
        </div>
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto rounded border p-2 dark:border-zinc-800">
          {catalog.map((s) => (
            <li key={s.name} className="text-xs">
              <span className="font-mono text-zinc-800 dark:text-zinc-200">{s.name}</span>{' '}
              <span className="text-zinc-500">— {s.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="font-medium">Custom skills</h3>
            <p className="text-sm text-zinc-500">
              Project-defined skills. Overlay the stock catalog. {Object.keys(skills).length} defined.
            </p>
          </div>
          <Button onClick={() => { setCreating(true); setEditing(null); }} variant="primary" disabled={pending}>
            New custom skill
          </Button>
        </div>

        {creating && (
          <SkillForm
            mode="create"
            onSubmit={(name, def) => wrap(async () => {
              await upsertCustomSkillAction(scope, name, def);
              setCreating(false);
            }, `Custom skill "${name}" created.`)}
            onCancel={() => setCreating(false)}
          />
        )}

        <ul className="mt-2 space-y-2">
          {Object.entries(skills).map(([name, def]) => (
            <li key={name} className="rounded border p-3 dark:border-zinc-800">
              {editing === name ? (
                <SkillForm
                  mode="edit"
                  name0={name}
                  initial={def}
                  onSubmit={(_, d) => wrap(async () => {
                    await upsertCustomSkillAction(scope, name, d);
                    setEditing(null);
                  }, `Custom skill "${name}" saved.`)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="font-mono">{name}</div>
                    <div className="text-xs text-zinc-500">{def.description}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      side effect: <span className="font-mono">{def.sideEffectClass}</span>
                      {def.endpoint ? (
                        <>
                          {' '}· endpoint: <span className="font-mono">{def.endpoint}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(name)} variant="secondary" disabled={pending}>Edit</Button>
                    <Button
                      onClick={() => {
                        if (!confirm(`Delete custom skill "${name}"?`)) return;
                        wrap(() => deleteCustomSkillAction(scope, name), `Custom skill "${name}" deleted.`);
                      }}
                      variant="secondary"
                      disabled={pending}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
          {Object.keys(skills).length === 0 && !creating && (
            <li className="text-sm italic text-zinc-500">No custom skills defined.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function SkillForm({
  mode, name0, initial, onSubmit, onCancel,
}: {
  mode: 'create' | 'edit';
  name0?: string;
  initial?: CustomSkillDef;
  onSubmit: (name: string, def: CustomSkillDef) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(name0 ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [authRef, setAuthRef] = useState(initial?.authRef ?? '');
  const [sideEffect, setSideEffect] = useState<CustomSkillDef['sideEffectClass']>(
    initial?.sideEffectClass ?? 'read',
  );
  const [inputSchema, setInputSchema] = useState(
    JSON.stringify(initial?.inputSchema ?? { type: 'object', properties: {}, required: [] }, null, 2),
  );
  const [outputSchema, setOutputSchema] = useState(
    initial?.outputSchema ? JSON.stringify(initial.outputSchema, null, 2) : '',
  );

  const submit = () => {
    if (mode === 'create' && !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) {
      alert('Skill name must be dotted lowercase, e.g. "tracker.list_issues".');
      return;
    }
    if (!description.trim()) {
      alert('Description is required.');
      return;
    }
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(inputSchema);
    } catch (e: any) {
      alert(`inputSchema: invalid JSON — ${e?.message ?? e}`);
      return;
    }
    let parsedOutput: Record<string, unknown> | undefined;
    if (outputSchema.trim()) {
      try {
        parsedOutput = JSON.parse(outputSchema);
      } catch (e: any) {
        alert(`outputSchema: invalid JSON — ${e?.message ?? e}`);
        return;
      }
    }
    onSubmit(name, {
      description: description.trim(),
      inputSchema: parsedInput,
      outputSchema: parsedOutput,
      endpoint: endpoint.trim() || undefined,
      authRef: authRef.trim() || undefined,
      sideEffectClass: sideEffect,
    });
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Name (dotted lowercase, e.g. "tracker.list_issues"){mode === 'edit' && ' — read-only'}
        </span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={mode === 'edit'}
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Description (shown to the model)</span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">Side-effect class</span>
          <select
            className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
            value={sideEffect}
            onChange={(e) => setSideEffect(e.target.value as any)}
          >
            <option value="read">read</option>
            <option value="write_workspace">write_workspace</option>
            <option value="write_external">write_external</option>
            <option value="irreversible">irreversible</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="block text-zinc-600 dark:text-zinc-400">HTTP endpoint (optional)</span>
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
            placeholder="https://..."
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Auth secret name (optional)</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          placeholder="e.g. MY_API_TOKEN"
          value={authRef}
          onChange={(e) => setAuthRef(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Input schema (JSON Schema)</span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={6}
          value={inputSchema}
          onChange={(e) => setInputSchema(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Output schema (optional, JSON Schema)</span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs dark:bg-zinc-900 dark:border-zinc-700"
          rows={4}
          value={outputSchema}
          onChange={(e) => setOutputSchema(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button onClick={submit} variant="primary">{mode === 'create' ? 'Create skill' : 'Save changes'}</Button>
        <Button onClick={onCancel} variant="secondary">Cancel</Button>
      </div>
    </div>
  );
}

// ─────────────── Gates tab ───────────────

function GatesTab({
  scope, gates, pending, wrap,
}: {
  scope: LifecycleScope;
  gates?: HumanGatesDef;
  pending: boolean;
  wrap: (run: () => Promise<unknown>, ok?: string) => void;
}) {
  const [promote, setPromote] = useState<HumanGatesDef['production_promote']>(
    gates?.production_promote ?? 'require-approval',
  );
  const [patternsText, setPatternsText] = useState(
    (gates?.sensitive_path_patterns ?? []).join('\n'),
  );
  const submit = () => {
    const patterns = patternsText.split('\n').map((s) => s.trim()).filter(Boolean);
    wrap(
      () => setHumanGatesAction(scope, { production_promote: promote, sensitive_path_patterns: patterns }),
      'Human gates saved.',
    );
  };
  return (
    <div className="space-y-3 max-w-xl">
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Production promote</span>
        <select
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          value={promote}
          onChange={(e) => setPromote(e.target.value as any)}
        >
          <option value="auto">auto</option>
          <option value="notify">notify</option>
          <option value="require-approval">require-approval</option>
        </select>
        <span className="mt-1 block text-xs text-zinc-500">
          Whether promoting a changeset to production runs without human, just notifies, or pauses for approval.
        </span>
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Sensitive path patterns (one per line, glob)</span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          rows={5}
          value={patternsText}
          onChange={(e) => setPatternsText(e.target.value)}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Tool calls that touch a matching path raise a gate that requires human approval.
        </span>
      </label>
      <Button onClick={submit} disabled={pending} variant="primary">Save gates</Button>
    </div>
  );
}
