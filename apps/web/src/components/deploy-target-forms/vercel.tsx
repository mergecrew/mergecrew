'use client';

import { type AdapterFormProps, Field, Select } from './shared';

interface VercelConfig {
  projectId?: string;
  teamId?: string;
  target?: 'preview' | 'production';
  repoSlug?: string;
}

export function VercelForm({ config, onChange }: AdapterFormProps) {
  const c = config as VercelConfig;
  const update = (patch: Partial<VercelConfig>) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Project ID"
        value={c.projectId ?? ''}
        onChange={(v) => update({ projectId: v })}
        placeholder="prj_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      />
      <Field
        label="Team ID (optional)"
        value={c.teamId ?? ''}
        onChange={(v) => update({ teamId: v })}
        placeholder="team_XXXXXXXXXXXXXXXXXXXX"
        hint="Leave empty for personal accounts."
      />
      <Select
        label="Target"
        value={c.target ?? 'preview'}
        options={[
          { value: 'preview', label: 'preview (per-branch URL)' },
          { value: 'production', label: 'production' },
        ]}
        onChange={(v) => update({ target: v })}
      />
      <Field
        label="Repo slug (owner/repo)"
        value={c.repoSlug ?? ''}
        onChange={(v) => update({ repoSlug: v })}
        placeholder="acme/webapp"
      />
    </div>
  );
}

export function vercelDefaultConfig(): Record<string, unknown> {
  return { projectId: '', target: 'preview', repoSlug: '' };
}
