'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Button, Card } from '@/components/ui';

/**
 * Seed-goal capture, shown as the final wizard card once the five
 * setup steps complete (#493). The free-form text becomes a queued
 * `IntentInboxItem` that the planner picks up on the next run as
 * `seedGoal`. Without this the first run hits the empty-brief path
 * and the planner asks "what would you like me to do?" — which is the
 * complaint we're closing.
 *
 * "Save and run" fires both the intent POST and the manual run POST,
 * then the server action redirects to the run-detail page so the
 * operator watches the timeline stream as it boots. "Skip" sends them
 * to the project page; without an intent the planner (#492) falls
 * into discovery mode and proposes three candidate directions
 * instead.
 */
export function SeedGoalCard({
  orgSlug,
  projectSlug,
  action,
}: {
  orgSlug: string;
  projectSlug: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [goal, setGoal] = useState('');
  const [pending, startTransition] = useTransition();
  const canSubmit = goal.trim().length > 0;

  return (
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-700/40 dark:bg-emerald-950/30">
      <form
        action={(fd) => startTransition(() => action(fd))}
        className="space-y-3"
      >
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <div className="space-y-1">
          <div className="font-medium">What should mergecrew work on first?</div>
          <p className="text-sm text-zinc-700 dark:text-zinc-200">
            Give the agents a concrete first task — one paragraph is enough.
            Mergecrew&apos;s planner will turn this into a plan, the coder will
            implement it, and the reviewer will gate it before the PR opens.
          </p>
        </div>
        <label className="block">
          <span className="sr-only">First task description</span>
          <textarea
            name="goal"
            required
            rows={4}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. add a /healthz endpoint and a smoke test that hits it"
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm dark:bg-zinc-900 dark:border-zinc-700"
          />
          <span className="mt-1 block text-xs text-zinc-500">
            Best results: ask for one small, scoped change rather than a
            quarter-long initiative. Examples: &ldquo;wire prettier into
            CI&rdquo;, &ldquo;convert any-types in src/api to specific
            types&rdquo;, &ldquo;add a 404 handler with a JSON
            body&rdquo;.
          </span>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href={`/orgs/${orgSlug}/projects/${projectSlug}`}
            className="text-sm text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Skip — let the planner explore on its own →
          </Link>
          <Button variant="primary" type="submit" disabled={pending || !canSubmit}>
            {pending ? 'Saving…' : 'Save and run'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
