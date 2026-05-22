'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  upsertPromotionStrategyAction,
  type PromotionStrategyInput,
  type PromotionStrategyKind,
} from './settings-actions';

export interface PromotionStrategy {
  kind: PromotionStrategyKind;
  releaseBranch: string | null;
  workflowFilename: string | null;
  envInputKey: string | null;
  envInputValue: string | null;
  tagPattern: string | null;
  prodUrl: string | null;
}

const COOKBOOK_BASE =
  'https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/06-deploy-targets-cookbook.md';

const PRESETS: Array<{
  kind: PromotionStrategyKind;
  title: string;
  blurb: string;
  anchor: string;
}> = [
  {
    kind: 'auto_deploy',
    title: 'Release branch + auto-deploy',
    blurb:
      'When mergecrew pushes to the release branch, your CI deploys to prod automatically. Pick this if a merge to main (or whatever your release branch is) already triggers your prod pipeline.',
    anchor: 'pattern-pa--release-branch--auto-deploy',
  },
  {
    kind: 'manual_workflow',
    title: 'Release branch + manual workflow',
    blurb:
      "mergecrew pushes the release branch; you click a workflow_dispatch in GitHub to deploy. Pick this if you keep a gated 'Deploy to prod' button in your CI.",
    anchor: 'pattern-pb--release-branch--manual-workflow',
  },
  {
    kind: 'tag_driven',
    title: 'Tag-driven',
    blurb:
      'mergecrew tags the release branch head; your CI deploys on tag. Pick this if you cut a versioned release artifact (v1.2.3 / 2026-05-17.1) per ship.',
    anchor: 'pattern-pc--tag-driven',
  },
  {
    kind: 'single_env',
    title: 'Single environment (no separate prod yet)',
    blurb:
      'When dev IS prod — pre-launch / pre-revenue projects with one environment. mergecrew runs no git on promote; the digest just lets you review what shipped or drop a bad change.',
    anchor: 'pattern-pe--single-environment',
  },
  {
    kind: 'deferred',
    title: "I'll configure this later",
    blurb:
      "Skip for now. The wizard completes, but the project page shows a 'Promotion not configured' chip until you come back to settings and pick a real strategy.",
    anchor: 'pattern-pd--deferred',
  },
];

/**
 * Wizard step 4b: capture how the human-approved subset of dev
 * changesets graduates to prod (#470). The cherry-pick engine (#471)
 * reads the row to decide what to do after building the release ref —
 * push, dispatch, or tag. `deferred` means "wizard completes without
 * committing; revisit in settings."
 *
 * Sane defaults derived from props: `releaseBranch` falls back to the
 * connected repo's effective base branch, `prodUrl` shows a placeholder
 * built from the org slug.
 */
export function PromotionStrategyForm({
  slug,
  projectSlug,
  initial,
  defaultReleaseBranch,
  orgSlug,
}: {
  slug: string;
  projectSlug: string;
  initial: PromotionStrategy | null;
  /**
   * Effective base branch from the connected repo (#469) — used as the
   * default for `releaseBranch` when the picker leaves it blank.
   */
  defaultReleaseBranch?: string;
  /** Hint the prod URL placeholder so users see something concrete. */
  orgSlug: string;
}) {
  const [kind, setKind] = useState<PromotionStrategyKind>(initial?.kind ?? 'auto_deploy');
  const [releaseBranch, setReleaseBranch] = useState(initial?.releaseBranch ?? '');
  const [workflowFilename, setWorkflowFilename] = useState(
    initial?.workflowFilename ?? 'deploy-prod.yml',
  );
  const [envInputKey, setEnvInputKey] = useState(initial?.envInputKey ?? 'environment');
  const [envInputValue, setEnvInputValue] = useState(initial?.envInputValue ?? 'prod');
  const [tagPattern, setTagPattern] = useState(initial?.tagPattern ?? 'v${YYYY-MM-DD}-${shortSha}');
  const [prodUrl, setProdUrl] = useState(initial?.prodUrl ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const branchPlaceholder = defaultReleaseBranch || 'main';
  const prodUrlPlaceholder = `https://${orgSlug}.com`;

  // Belt-and-suspenders alongside the per-input `required` attributes:
  // catches anyone who reaches `onSave` by other means (programmatic
  // form submit, future Save-on-Enter wiring) so we never POST a
  // payload the server is guaranteed to 400 on (#479).
  const missingForKind = (): string | null => {
    if (kind === 'auto_deploy' && !prodUrl.trim()) return 'Prod URL is required.';
    if (kind === 'manual_workflow') {
      if (!workflowFilename.trim()) return 'Workflow filename is required.';
      if (!prodUrl.trim()) return 'Prod URL is required.';
    }
    if (kind === 'tag_driven') {
      if (!tagPattern.trim()) return 'Tag pattern is required.';
      if (!prodUrl.trim()) return 'Prod URL is required.';
    }
    return null;
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const missing = missingForKind();
    if (missing) {
      setError(missing);
      return;
    }
    const payload: PromotionStrategyInput = { kind };
    if (kind === 'auto_deploy') {
      payload.releaseBranch = releaseBranch.trim() || null;
      payload.prodUrl = prodUrl.trim();
    } else if (kind === 'manual_workflow') {
      payload.releaseBranch = releaseBranch.trim() || null;
      payload.workflowFilename = workflowFilename.trim();
      payload.envInputKey = envInputKey.trim() || null;
      payload.envInputValue = envInputValue.trim() || null;
      payload.prodUrl = prodUrl.trim();
    } else if (kind === 'tag_driven') {
      payload.tagPattern = tagPattern.trim();
      payload.prodUrl = prodUrl.trim();
    }
    // single_env + deferred submit `{kind}` only — no fields to carry.
    startTransition(async () => {
      try {
        await upsertPromotionStrategyAction(slug, projectSlug, payload);
      } catch (err: any) {
        setError(String(err?.message ?? err));
      }
    });
  };

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate={false}>
      <fieldset className="space-y-2">
        <legend className="sr-only">Promotion strategy</legend>
        {PRESETS.map((p) => (
          <label
            key={p.kind}
            className={`flex cursor-pointer items-start gap-3 rounded border p-3 text-sm ${
              kind === p.kind
                ? 'border-sky-400 bg-sky-50/60 dark:border-sky-600 dark:bg-sky-950/30'
                : 'border-zinc-200 '
            }`}
          >
            <input
              type="radio"
              name="promotion-strategy"
              className="mt-0.5"
              checked={kind === p.kind}
              onChange={() => setKind(p.kind)}
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{p.title}</div>
              <p className="text-xs text-ink-2">{p.blurb}</p>
              <a
                href={`${COOKBOOK_BASE}#${p.anchor}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline"
              >
                Learn more →
              </a>
            </div>
          </label>
        ))}
      </fieldset>

      {kind === 'auto_deploy' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Release branch"
            value={releaseBranch}
            onChange={setReleaseBranch}
            placeholder={branchPlaceholder}
            hint="mergecrew cherry-picks approved changesets onto this branch and pushes. Defaults to the connected repo's base PR branch."
          />
          <Field
            label="Prod URL"
            value={prodUrl}
            onChange={setProdUrl}
            placeholder={prodUrlPlaceholder}
            hint="Where the prod build is reachable after your CI deploys it."
            required
            type="url"
          />
        </div>
      )}

      {kind === 'manual_workflow' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Release branch"
            value={releaseBranch}
            onChange={setReleaseBranch}
            placeholder={branchPlaceholder}
          />
          <Field
            label="Workflow filename"
            value={workflowFilename}
            onChange={setWorkflowFilename}
            placeholder="deploy-prod.yml"
            hint="A file in .github/workflows/."
            required
          />
          <Field
            label="Env input key"
            value={envInputKey}
            onChange={setEnvInputKey}
            placeholder="environment"
            hint="Workflow input name your dispatch passes a value to."
          />
          <Field
            label="Env input value"
            value={envInputValue}
            onChange={setEnvInputValue}
            placeholder="prod"
          />
          <Field
            label="Prod URL"
            value={prodUrl}
            onChange={setProdUrl}
            placeholder={prodUrlPlaceholder}
            required
            type="url"
          />
        </div>
      )}

      {kind === 'tag_driven' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Tag pattern"
            value={tagPattern}
            onChange={setTagPattern}
            placeholder="v${YYYY-MM-DD}-${shortSha}"
            hint="Interpolated at tag time. Supports ${YYYY-MM-DD}, ${shortSha}."
            required
          />
          <Field
            label="Prod URL"
            value={prodUrl}
            onChange={setProdUrl}
            placeholder={prodUrlPlaceholder}
            required
            type="url"
          />
        </div>
      )}

      {kind === 'single_env' && (
        <p className="rounded border border-dashed p-3 text-xs text-zinc-600 dark:text-muted-2">
          Nothing to fill out. The daily digest will surface what merged with a single{' '}
          <span className="font-medium">Mark reviewed</span> action — no release branch, no
          cherry-pick, no prod URL needed. Drop still opens a revert PR on your base branch.
        </p>
      )}

      {kind === 'deferred' && (
        <p className="rounded border border-dashed p-3 text-xs text-zinc-600 dark:text-muted-2">
          You can come back here whenever you&apos;re ready. Until then, the daily promote digest
          will show a chip linking back to settings instead of a Promote button.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update strategy' : 'Save strategy'}
        </Button>
        {initial && (
          <span className="text-xs text-muted">
            Currently: <span className="font-mono">{initial.kind}</span>
          </span>
        )}
      </div>

      {error && (
        <div className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  required,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  type?: 'text' | 'url';
}) {
  return (
    <label className="text-sm">
      <span className="block text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-rose-600 dark:text-rose-400">*</span>}
      </span>
      <input
        className="mt-2 w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] font-mono "
        value={value}
        placeholder={placeholder}
        required={required}
        type={type}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}
