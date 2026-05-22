'use client';

import { useState, useTransition } from 'react';
import { Button, Input } from '@/components/ui';
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
    <div className="space-y-4">
      <label className="block">
        <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          Name
        </span>
        <Input className="mt-2" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block">
        <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          Description{' '}
          <span className="text-[11px] normal-case tracking-normal text-muted-2">
            — shown to agents and humans alike
          </span>
        </span>
        <textarea
          className="mt-2 w-full border border-hair bg-paper-2 px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          rows={3}
          placeholder="What this project is, who it's for, and the technical context that any new contributor (or agent) should know."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          Slug
        </span>
        <Input
          className="mt-2 cursor-not-allowed bg-bg text-muted"
          mono
          value={projectSlug}
          readOnly
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={pending || !dirty} variant="accent" size="sm">
          Save changes
        </Button>
        {savedAt && <span className="font-mono text-[11.5px] text-muted">Saved at {savedAt}.</span>}
        <span className="ml-auto" />
        <Button onClick={onArchive} disabled={pending} variant="ghost" size="sm">
          {archived ? 'Unarchive project' : 'Archive project'}
        </Button>
      </div>
      {archived && (
        <p className="m-0 border border-warn bg-warn/20 p-3 text-[12.5px] text-ink">
          This project is archived — it won&apos;t be picked up by the daily scheduler. You can
          still view its history.
        </p>
      )}
    </div>
  );
}
