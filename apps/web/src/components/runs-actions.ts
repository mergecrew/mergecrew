'use server';

import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

/**
 * Trigger a manual run on a project and server-side-redirect to the
 * new run's live-timeline page (#407, #406, V2.aj).
 *
 * The API pre-creates the DailyRun row (#407) so the runId is known
 * at response time — no race against the orchestrator. Used by both
 * the project page's "Run now" form and the welcome card's "Try a
 * sample run" CTA, since both want the same post-trigger UX.
 *
 * Reads org / project slug from the FormData rather than as direct
 * args so it can be passed straight to <form action={…}> without a
 * client-side wrapper.
 */
export async function triggerRunAction(formData: FormData) {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  if (!orgSlug || !projectSlug) return;
  const session = await requireSession();
  const result = await api<{ runId?: string }>(
    `/v1/orgs/${orgSlug}/projects/${projectSlug}/runs`,
    { method: 'POST', body: '{}', session },
  );
  if (result?.runId) {
    redirect(`/orgs/${orgSlug}/projects/${projectSlug}/runs/${result.runId}`);
  }
}
