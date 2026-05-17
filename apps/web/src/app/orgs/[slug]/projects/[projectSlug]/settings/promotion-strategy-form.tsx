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
      "When mergecrew pushes to the release branch, your CI deploys to prod automatically. Pick this if a merge to main (or whatever your release branch is) already triggers your prod pipeline.",
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
      "mergecrew tags the release branch head; your CI deploys on tag. Pick this if you cut a versioned release artifact (v1.2.3 / 2026-05-17.1) per ship.",
    anchor: 'pattern-pc--tag-driven',
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
  const [tagPattern, setTagPattern] = useState(
    initial?.tagPattern ?? 'v${YYYY-MM-DD}-${shortSha}',
  );
  const [prodUrl, setProdUrl] = useState(initial?.prodUrl ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const branchPlaceholder = defaultReleaseBranch || 'main';
  const prodUrlPlaceholder = `https://${orgSlug}.com`;

  const onSave = () => {
    setError(null);
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
    startTransition(async () => {
      try {
        await upsertPromotionStrategyAction(slug, projectSlug, payload);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    });
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">Promotion strategy</legend>
        {PRESETS.map((p) => (
          <label
            key={p.kind}
            className={`flex cursor-pointer items-start gap-3 rounded border p-3 text-sm ${
              kind === p.kind
                ? 'border-sky-400 bg-sky-50/60 dark:border-sky-600 dark:bg-sky-950/30'
                : 'border-zinc-200 dark:border-zinc-700'
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
              <p className="text-xs text-zinc-600 dark:text-zinc-400">{p.blurb}</p>
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
          />
          <Field
            label="Prod URL"
            value={prodUrl}
            onChange={setProdUrl}
            placeholder={prodUrlPlaceholder}
          />
        </div>
      )}

      {kind === 'deferred' && (
        <p className="rounded border border-dashed p-3 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          You can come back here whenever you&apos;re ready. Until then, the
          daily promote digest will show a chip linking back to settings instead
          of a Promote button.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={onSave} disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update strategy' : 'Save strategy'}
        </Button>
        {initial && (
          <span className="text-xs text-zinc-500">
            Currently: <span className="font-mono">{initial.kind}</span>
          </span>
        )}
      </div>

      {error && (
        <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="text-sm">
      <span className="block text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
