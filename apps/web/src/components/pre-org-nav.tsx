import Link from 'next/link';
import { Wordmark } from './ui';
import { UserMenu } from './user-menu';

/**
 * Top header for routes that live outside the `(org)` route group —
 * specifically `/` (zero-orgs branch) and `/orgs/new`. The org-scoped
 * TopBar can't render here because it needs an `orgSlug`; this nav
 * fills the gap so signed-in pre-org users still see Mergecrew
 * branding and the same `<UserMenu>` they'd see elsewhere.
 */
export function PreOrgNav() {
  return (
    <header className="border-b border-hair bg-paper">
      <div className="mx-auto flex max-w-6xl items-center justify-between p-4">
        <Wordmark withTag />
        <nav className="flex items-center gap-4 text-[13.5px]">
          <a
            href="https://github.com/mergecrew/mergecrew"
            className="hidden text-ink-2 no-underline hover:text-accent sm:inline"
          >
            GitHub
          </a>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/README.md"
            className="hidden text-ink-2 no-underline hover:text-accent sm:inline"
          >
            Docs
          </a>
          <a
            href="https://github.com/orgs/mergecrew/projects/1"
            className="hidden text-ink-2 no-underline hover:text-accent sm:inline"
          >
            Roadmap
          </a>
          <UserMenu />
        </nav>
      </div>
    </header>
  );
}
