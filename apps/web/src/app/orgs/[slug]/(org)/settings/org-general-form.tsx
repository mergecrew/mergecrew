'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';

type SaveResult =
  | { ok: true; newSlug: string }
  | { ok: false; error: string };

/**
 * Org rename / slug-change form.
 *
 * Slug input echoes the API's validation pattern (lowercase a-z0-9, hyphens
 * between, 2–48 chars) so the user sees the constraint locally rather than
 * round-tripping for a 422. Save is disabled while the values match what's
 * already saved, so the button doesn't fire a useless PATCH on every nav.
 */
export function OrgGeneralForm({
  initialName,
  initialSlug,
  canEdit,
  onSave,
}: {
  initialName: string;
  initialSlug: string;
  canEdit: boolean;
  onSave: (input: { name?: string; slug?: string }) => Promise<SaveResult>;
}) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dirty = name.trim() !== initialName || slug.trim() !== initialSlug;
  const slugValid = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug.trim());
  const nameValid = name.trim().length > 0 && name.trim().length <= 80;

  const submit = () => {
    setError(null);
    setSaved(null);
    const patch: { name?: string; slug?: string } = {};
    if (name.trim() !== initialName) patch.name = name.trim();
    if (slug.trim() !== initialSlug) patch.slug = slug.trim();
    startTransition(async () => {
      const r = await onSave(patch);
      if (r.ok) {
        setSaved('Saved.');
      } else {
        setError(r.error);
      }
    });
  };

  if (!canEdit) {
    return (
      <dl className="space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="w-24 text-zinc-500">Name</dt>
          <dd>{initialName}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 text-zinc-500">Slug</dt>
          <dd>
            <code>{initialSlug}</code>
          </dd>
        </div>
        <p className="pt-2 text-xs text-zinc-500">Only admins can edit.</p>
      </dl>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Name</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        {!nameValid && (
          <span className="block text-xs text-rose-600 dark:text-rose-400">
            Name is required (max 80 chars).
          </span>
        )}
      </label>
      <label className="text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Slug (URL)</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          maxLength={48}
        />
        {!slugValid && (
          <span className="block text-xs text-rose-600 dark:text-rose-400">
            2–48 chars, lowercase a–z, 0–9, hyphens between (no leading/trailing hyphen).
          </span>
        )}
      </label>
      <div className="sm:col-span-2 flex items-center gap-3">
        <Button
          variant="primary"
          onClick={submit}
          disabled={pending || !dirty || !nameValid || !slugValid}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{saved}</span>}
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </div>
  );
}
