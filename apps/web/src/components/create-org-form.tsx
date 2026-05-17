'use client';

import { useState, useTransition } from 'react';
import { Button } from './ui';
import { slugify } from '@/lib/slugify';

/**
 * Shared create-org form (#412-style flow). Used on `/` (zero-orgs
 * branch) and `/orgs/new`. Auto-derives the slug from the org name
 * live as the user types, but stops auto-deriving the moment the
 * user touches the slug input — matches GitHub/Vercel/Linear's "I
 * intended this slug" pattern so a typed slug can't get clobbered
 * by a later name edit.
 */
export function CreateOrgForm({
  action,
  submitLabel = 'Create organization',
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel?: string;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => startTransition(() => action(fd))}
      className="space-y-4"
    >
      <label className="block text-sm">
        <span className="text-zinc-600 dark:text-zinc-300">Organization name</span>
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
          placeholder="Acme Co."
          className="mt-1 block w-full rounded border px-3 py-2 bg-transparent"
        />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-600 dark:text-zinc-300">Slug</span>
        <input
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlug(slugify(e.target.value));
            setSlugTouched(true);
          }}
          className="mt-1 block w-full rounded border px-3 py-2 bg-transparent font-mono"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Used in URLs: <code className="font-mono">/orgs/{slug || 'your-slug'}</code>. Edit to override.
        </p>
      </label>
      <div className="flex justify-end">
        <Button
          variant="primary"
          type="submit"
          disabled={pending || !name.trim() || !slug.trim()}
        >
          {pending ? 'Creating…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
