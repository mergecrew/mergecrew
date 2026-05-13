import Link from 'next/link';
import { UserMenu } from './user-menu';

/**
 * Top header for routes that live outside the `(org)` route group —
 * specifically `/` (zero-orgs branch) and `/orgs/new`. The org-scoped
 * AppBar can't render here because it needs an `orgSlug`; this nav
 * fills the gap so signed-in pre-org users still see Mergecrew
 * branding, docs links, and the same `<UserMenu>` (org switcher +
 * sign-out + "+ New organization") they'd see elsewhere in the app.
 *
 * Style is lifted from the logged-out marketing `Landing.Nav()` in
 * `apps/web/src/app/page.tsx` so the brand pill + docs links feel
 * consistent across both audiences.
 */
export function PreOrgNav() {
  return (
    <header className="border-b border-zinc-200/60 dark:border-zinc-800/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between p-4">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">Mergecrew</span>
          <span className="rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-orange-700 dark:border-orange-700/40 dark:bg-orange-950/40 dark:text-orange-300">
            alpha
          </span>
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <a
            href="https://github.com/mergecrew/mergecrew"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            GitHub
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/README.md"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            Docs
          </a>
          <a
            href="https://github.com/orgs/mergecrew/projects/1"
            className="hidden text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 sm:inline"
          >
            Roadmap
          </a>
          <UserMenu />
        </nav>
      </div>
    </header>
  );
}
