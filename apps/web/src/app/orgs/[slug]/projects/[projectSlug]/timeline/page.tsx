import { redirect } from 'next/navigation';
import { apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, LinkButton } from '@/components/ui';

/**
 * The Timeline tab is a passthrough to the latest run's detail page (which
 * renders the live SSE timeline + transcript). When there's no run yet,
 * we show a "Run now" CTA instead of redirecting nowhere useful.
 */
export default async function TimelinePage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const runs = await apiOr404<{ items: { id: string }[] }>(
    `/v1/orgs/${slug}/projects/${projectSlug}/runs?limit=1`,
    { session },
  );
  const latest = runs.items[0];

  if (latest) {
    redirect(`/orgs/${slug}/projects/${projectSlug}/runs/${latest.id}`);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Timeline</h1>
        <p className="text-sm text-zinc-500">
          Live transcript of the project's most recent run.
        </p>
      </header>
      <Card>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          No runs yet for this project. Trigger one to see the timeline stream live.
        </p>
        <div className="mt-3">
          <LinkButton
            href={`/orgs/${slug}/projects/${projectSlug}`}
            variant="primary"
          >
            Go to project overview
          </LinkButton>
        </div>
      </Card>
    </main>
  );
}
