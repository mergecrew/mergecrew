'use client';

import { useState, useTransition } from 'react';
import { updateProjectAction } from './settings-actions';

type Profile = 'fast' | 'careful' | 'custom';

export function GraphProfileForm({
  slug,
  projectSlug,
  initialProfile,
  initialYaml,
  canEdit,
}: {
  slug: string;
  projectSlug: string;
  initialProfile: Profile;
  initialYaml: string | null;
  canEdit: boolean;
}) {
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [yaml, setYaml] = useState<string>(initialYaml ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (next: { profile?: Profile; yaml?: string }) => {
    setError(null);
    const profileToSave = next.profile ?? profile;
    const yamlToSave = next.yaml ?? yaml;
    startTransition(async () => {
      try {
        await updateProjectAction(slug, projectSlug, {
          graphProfile: profileToSave,
          graphYaml: profileToSave === 'custom' ? yamlToSave : null,
        });
        setProfile(profileToSave);
        if (next.yaml !== undefined) setYaml(yamlToSave);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {(['fast', 'careful', 'custom'] as const).map((p) => (
          <label key={p} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="graphProfile"
              value={p}
              className="mt-0.5"
              checked={profile === p}
              onChange={() => save({ profile: p })}
              disabled={pending || !canEdit}
            />
            <span>
              <span className="font-medium">{labelFor(p)}</span>
              <span className="block text-ink-2">{descFor(p)}</span>
            </span>
          </label>
        ))}
      </div>

      {profile === 'custom' && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted">graph yaml</label>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            onBlur={() => save({ yaml })}
            disabled={pending || !canEdit}
            spellCheck={false}
            rows={14}
            className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs "
            placeholder={`version: 1
graph:
 nodes:
 planner: { agentRef: planner }
 coder: { agentRef: coder }
 reviewer: { agentRef: reviewer }
 edges:
 - from: planner
 to: coder
 - from: coder
 to: reviewer
 - from: reviewer
 to: coder
 when: requestChanges
 - from: reviewer
 to: __end__
 when: approve`}
          />
          <p className="text-xs text-muted">
            Validated on save. See{' '}
            <a
              href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/18-multi-agent.md"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-[3px] hover:underline hover:text-zinc-700 dark:hover:text-muted-2"
            >
              the multi-agent cookbook
            </a>{' '}
            for the schema + worked examples.
          </p>
        </div>
      )}

      {error && (
        <div className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </div>
      )}
      {!canEdit && <p className="text-xs text-muted">Only operators can change this.</p>}
    </div>
  );
}

function labelFor(p: Profile): string {
  if (p === 'fast') return 'Fast (single agent)';
  if (p === 'careful') return 'Careful (planner → coder → reviewer)';
  return 'Custom (YAML)';
}

function descFor(p: Profile): string {
  if (p === 'fast') {
    return 'V1 behavior — one agent per workflow node. Cheapest and quickest. Good for prototypes and single-developer projects.';
  }
  if (p === 'careful') {
    return 'Planner produces a plan, coder implements it, reviewer gates before PR open. ~2-2.5× the cost of fast in exchange for fewer human review cycles.';
  }
  return 'Bring your own graph. YAML body below; validated on save.';
}
