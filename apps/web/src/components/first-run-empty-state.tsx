import Link from 'next/link';
import { Card, LinkButton } from './ui';

/**
 * Empty-state card shown when an org has zero projects (#272).
 * Tells a first-time operator what to actually do, instead of leaving
 * them on an empty list with just a "New project" button.
 */
export function FirstRunEmptyState({ orgSlug }: { orgSlug: string }) {
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">No projects yet — try these first</h2>
        <p className="mt-1 text-sm text-zinc-500">
          A Mergecrew project points at one GitHub repo on a daily cadence. New here?
          Walk through the sample app before pointing it at code you care about.
        </p>
      </div>

      <ul className="space-y-3">
        <CTA
          title="Try the sample app"
          description="A throwaway Next.js repo with one deliberate bug. Connect it, click Run now, watch the loop open a PR and ship a preview — without touching your real codebase."
          href="https://github.com/mergecrew/mergecrew-sample-app"
          external
          buttonLabel="Open sample-app"
        />
        <CTA
          title="Read the deploy-target cookbook"
          description="Copy-paste configs for the common shapes: Vercel preview, push-triggered ECS Fargate, manual prod gate, raw AWS SDK, Fly / Render / Railway."
          href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/06-deploy-targets-cookbook.md"
          external
          buttonLabel="Open cookbook"
        />
        <CTA
          title="Create my first project"
          description="Skip the warm-up. You can configure repo + deploy target after the project exists."
          href={`/orgs/${orgSlug}/projects/new`}
          buttonLabel="New project"
          primary
        />
      </ul>
    </Card>
  );
}

function CTA({
  title,
  description,
  href,
  external,
  buttonLabel,
  primary,
}: {
  title: string;
  description: string;
  href: string;
  external?: boolean;
  buttonLabel: string;
  primary?: boolean;
}) {
  return (
    <li className="flex flex-col items-start gap-2 rounded-md border p-3 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
      </div>
      {external ? (
        <Link
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={
            primary
              ? 'inline-flex shrink-0 items-center justify-center rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg hover:opacity-90'
              : 'inline-flex shrink-0 items-center justify-center rounded-md border bg-transparent px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }
        >
          {buttonLabel}
        </Link>
      ) : (
        <LinkButton href={href} variant={primary ? 'primary' : 'secondary'}>
          {buttonLabel}
        </LinkButton>
      )}
    </li>
  );
}
