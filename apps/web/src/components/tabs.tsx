import Link from 'next/link';
import { clsx } from 'clsx';

export interface TabDef {
  id: string;
  label: string;
}

/**
 * Server-rendered horizontal tab strip. State lives in the URL
 * (`?tab=<id>`) so deep links + browser-back work without any client
 * JS. Each Tab is a Link to the same route with the relevant query
 * param swapped in; the page reads the active tab from searchParams.
 *
 * `pathname` is required because Next.js' Link only knows where to go
 * if you tell it — server components don't have access to
 * `usePathname()`. Pass the absolute path of the current route from
 * the page itself.
 */
export function TabStrip({
  tabs,
  active,
  pathname,
  className,
}: {
  tabs: TabDef[];
  active: string;
  pathname: string;
  className?: string;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Settings sections"
      className={clsx('flex flex-wrap gap-1 border-b border-hair', className)}
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <Link
            key={t.id}
            href={`${pathname}?tab=${t.id}`}
            role="tab"
            aria-selected={isActive}
            className={clsx(
              'rounded-t-md px-3 py-1.5 text-sm transition-colors',
              isActive
                ? 'border-b-2 border-accent font-medium text-accent'
                : 'border-b-2 border-transparent text-zinc-600 hover:text-ink dark:text-muted-2 ',
            )}
            // Negative bottom margin pulls the active underline onto
            // the strip's border so it visually replaces (rather than
            // doubles) that line.
            style={{ marginBottom: '-1px' }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
