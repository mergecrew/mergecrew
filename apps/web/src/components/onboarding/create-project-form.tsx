'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { slugify } from '@/lib/slugify';

/**
 * Inline create-first-project form for the wizard (#455). Mirrors
 * `CreateOrgForm`: auto-derives a slug from the name as the user types,
 * stops auto-deriving the moment the user touches the slug field
 * (the GitHub / Vercel / Linear "I intended this slug" pattern), so a
 * typed slug can't get clobbered by a later name edit.
 *
 * Submits to a server-action prop. The wizard's action POSTs to
 * `/v1/orgs/{slug}/projects` and `revalidatePath`s the wizard route so
 * the active step advances inline — no `redirect()` here, unlike the
 * shared `/projects/new` page.
 */
export function CreateProjectForm({
  orgSlug,
  action,
  submitLabel = 'Create project',
}: {
  orgSlug: string;
  action: (formData: FormData) => Promise<void>;
  submitLabel?: string;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, startTransition] = useTransition();

  const canSubmit = name.trim().length > 0 && slug.trim().length > 0;

  return (
    <form
      action={(fd) => startTransition(() => action(fd))}
      className="space-y-3 rounded-md border border-zinc-200 bg-white/60 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/40"
    >
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <label className="block">
        <span className="text-zinc-600 dark:text-zinc-300">Project name</span>
        <input
          name="name"
          required
          autoFocus
          value={name}
          onChange={(e) => {
            const v = e.target.value;
            setName(v);
            if (!slugTouched) setSlug(slugify(v));
          }}
          placeholder="Acme Billing"
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
        />
      </label>
      <label className="block">
        <span className="text-zinc-600 dark:text-zinc-300">Slug</span>
        <input
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          placeholder="acme-billing"
          className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Used in URLs; lowercase letters, numbers, and dashes only.
        </span>
      </label>
      <Button variant="primary" type="submit" disabled={pending || !canSubmit}>
        {pending ? 'Creating…' : submitLabel}
      </Button>
    </form>
  );
}
