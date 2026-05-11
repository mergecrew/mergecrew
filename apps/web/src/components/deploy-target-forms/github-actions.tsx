'use client';

import { type AdapterFormProps, Field, Select } from './shared';

interface GhConfig {
  installationId?: string;
  repoFullName?: string;
  workflowFilename?: string;
  inputsTemplate?: Record<string, string>;
  triggerMode?: 'dispatch' | 'observe';
  observeFindTimeoutMs?: number;
  urlResolution?: 'pattern' | 'fixed' | 'workflow_output';
  urlPattern?: string;
  urlFixed?: string;
}

export function GitHubActionsForm({ config, onChange }: AdapterFormProps) {
  const c = config as GhConfig;
  const update = (patch: Partial<GhConfig>) => onChange({ ...c, ...patch });
  const triggerMode = c.triggerMode ?? 'dispatch';
  const urlResolution = c.urlResolution ?? 'pattern';

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field
        label="Installation ID"
        value={c.installationId ?? ''}
        onChange={(v) => update({ installationId: v })}
        hint="GitHub App installation that owns the repo's Actions API."
      />
      <Field
        label="Repository (owner/repo)"
        value={c.repoFullName ?? ''}
        onChange={(v) => update({ repoFullName: v })}
        placeholder="acme/webapp"
      />
      <Field
        label="Workflow filename"
        value={c.workflowFilename ?? ''}
        onChange={(v) => update({ workflowFilename: v })}
        placeholder="deploy-dev.yml"
        hint="A file in .github/workflows/."
      />
      <Select
        label="Trigger mode"
        value={triggerMode}
        options={[
          { value: 'dispatch', label: 'dispatch (Mergecrew calls workflowDispatch)' },
          { value: 'observe', label: 'observe (watch the existing push/PR run)' },
        ]}
        onChange={(v) => update({ triggerMode: v })}
        hint={
          triggerMode === 'observe'
            ? 'For repos where merging to main already auto-deploys; Mergecrew watches that run.'
            : 'Mergecrew calls workflow_dispatch on the workflow above. Used for manual prod gates.'
        }
      />
      <Select
        label="URL resolution"
        value={urlResolution}
        options={[
          { value: 'pattern', label: 'pattern (interpolate ${branch} / ${sha})' },
          { value: 'fixed', label: 'fixed (single shared URL)' },
          { value: 'workflow_output', label: 'workflow_output (read from job output)' },
        ]}
        onChange={(v) => update({ urlResolution: v })}
      />
      {urlResolution === 'pattern' && (
        <Field
          label="URL pattern"
          value={c.urlPattern ?? ''}
          onChange={(v) => update({ urlPattern: v })}
          placeholder="https://${branch}.preview.example.com"
        />
      )}
      {urlResolution === 'fixed' && (
        <Field
          label="Fixed URL"
          value={c.urlFixed ?? ''}
          onChange={(v) => update({ urlFixed: v })}
          placeholder="https://dev.example.com"
        />
      )}
    </div>
  );
}

export function githubActionsDefaultConfig(): Record<string, unknown> {
  return {
    installationId: '',
    repoFullName: '',
    workflowFilename: 'deploy-dev.yml',
    inputsTemplate: { branch: '${ref.branch}' },
    triggerMode: 'dispatch',
    urlResolution: 'pattern',
    urlPattern: '',
  };
}
