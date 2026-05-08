'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { updateProjectAction } from './settings-actions';

export function GeneralForm({
  slug,
  projectSlug,
  initialName,
  initialDescription,
  archived,
}: {
  slug: string;
  projectSlug: string;
  initialName: string;
  initialDescription: string;
  archived: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty = name.trim() !== initialName || description.trim() !== initialDescription;

  const onSave = () => {
    startTransition(async () => {
      await updateProjectAction(slug, projectSlug, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
      });
      setSavedAt(new Date().toLocaleTimeString());
    });
  };

  const onArchive = () => {
    startTransition(async () => {
      await updateProjectAction(slug, projectSlug, { archived: !archived });
    });
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Name</span>
        <input
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">
          Description{' '}
          <span className="text-xs text-zinc-400">— shown to agents and humans alike</span>
        </span>
        <textarea
          className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
          rows={3}
          placeholder="What this project is, who it's for, and the technical context that any new contributor (or agent) should know."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Slug</span>
        <input
          className="mt-1 w-full cursor-not-allowed rounded border bg-zinc-50 px-2 py-1 font-mono text-zinc-500 dark:bg-zinc-900 dark:border-zinc-700"
          value={projectSlug}
          readOnly
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={pending || !dirty} variant="primary">
          Save changes
        </Button>
        {savedAt && (
          <span className="text-xs text-zinc-500">Saved at {savedAt}.</span>
        )}
        <span className="ml-auto" />
        <Button onClick={onArchive} disabled={pending} variant="secondary">
          {archived ? 'Unarchive project' : 'Archive project'}
        </Button>
      </div>
      {archived && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          This project is archived — it won't be picked up by the daily scheduler. You can still
          view its history.
        </p>
      )}
    </div>
  );
}
