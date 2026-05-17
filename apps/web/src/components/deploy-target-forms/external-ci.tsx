'use client';

import { type AdapterFormProps, Field } from './shared';

interface ExternalCiConfig {
  urlFixed?: string;
  urlPattern?: string;
}

/**
 * External-CI deploy adapter form (#467).
 *
 * The whole point of this adapter is that the user's existing CI/CD
 * pipeline already builds and deploys on merge — mergecrew just needs
 * to know the public URL so downstream skills (smoke checks, screenshot
 * diffs) have a target. So the form is one field: the preview URL.
 *
 * Advanced users can put `${branch}` / `${sha}` placeholders in the URL
 * for per-branch preview hosts; the adapter interpolates at runtime.
 */
export function ExternalCiForm({ config, onChange }: AdapterFormProps) {
  const c = config as ExternalCiConfig;
  const update = (patch: Partial<ExternalCiConfig>) => onChange({ ...c, ...patch });

  return (
    <div className="grid gap-2">
      <Field
        label="Preview URL"
        value={c.urlFixed ?? ''}
        onChange={(v) => update({ urlFixed: v })}
        placeholder="https://dev.example.com"
        hint={
          <>
            Where your CI/CD publishes after a merge to the base branch.
            Advanced: use <code>{'${branch}'}</code> / <code>{'${sha}'}</code> for
            per-branch hosts (e.g. <code>{'https://${branch}.preview.example.com'}</code>).
          </>
        }
      />
    </div>
  );
}

export function externalCiDefaultConfig(): Record<string, unknown> {
  return {
    urlFixed: '',
  };
}
