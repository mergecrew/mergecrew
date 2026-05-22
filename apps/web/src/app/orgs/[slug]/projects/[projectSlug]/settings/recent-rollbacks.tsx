import Link from 'next/link';

interface Rollback {
  id: string;
  title: string;
  revertPrNumber: number | null;
  revertPrUrl: string | null;
  updatedAt: string;
}

export function RecentRollbacks({
  slug,
  projectSlug,
  rollbacks,
}: {
  slug: string;
  projectSlug: string;
  rollbacks: Rollback[];
}) {
  if (rollbacks.length === 0) {
    return (
      <p className="text-xs text-muted">
        No rollbacks recorded yet. When an admin clicks <em>Roll back</em> on a merged changeset,
        the revert PR shows up here.
      </p>
    );
  }
  return (
    <ul className="space-y-2 text-sm">
      {rollbacks.map((r) => (
        <li
          key={r.id}
          className="flex items-baseline justify-between gap-2 rounded border border-zinc-200 px-3 py-2 "
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.title}</div>
            <div className="text-xs text-muted">
              {new Date(r.updatedAt).toLocaleString()}
              {r.revertPrUrl && r.revertPrNumber && (
                <>
                  {' · '}
                  <a
                    href={r.revertPrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline-offset-[3px] hover:underline hover:text-zinc-700 dark:hover:text-muted-2"
                  >
                    revert PR #{r.revertPrNumber}
                  </a>
                </>
              )}
            </div>
          </div>
          <Link
            href={`/orgs/${slug}/projects/${projectSlug}/changesets/${r.id}`}
            className="shrink-0 text-xs text-muted text-accent underline-offset-[3px] hover:underline hover:text-zinc-700 dark:hover:text-muted-2"
          >
            View →
          </Link>
        </li>
      ))}
    </ul>
  );
}
