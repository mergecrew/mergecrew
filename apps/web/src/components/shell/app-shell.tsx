'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { Menu, X } from 'lucide-react';

/**
 * Wraps the org/project layouts in a responsive shell. On `md+` the
 * layout is the original 260px-sidebar + 1fr-main grid. On `< md` the
 * sidebar collapses into an off-canvas drawer toggled by a hamburger
 * button overlaid on the top-left of the TopBar.
 *
 * Server layouts pass pre-rendered `topbar` and `sidebar` ReactNodes —
 * the drawer state lives on the client, but the underlying TopBar /
 * Sidebar components stay server-side and keep their existing data
 * fetching.
 */
export function AppShell({
  topbar,
  sidebar,
  children,
}: {
  topbar: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Auto-close the drawer on route change so a tap on a sidebar link
  // doesn't leave the overlay covering the next page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="grid h-screen grid-rows-[56px_1fr] bg-bg md:grid-cols-[260px_1fr]">
      <div className="relative md:col-span-2">
        <button
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="absolute left-0 top-0 z-[60] flex h-[56px] w-[56px] items-center justify-center border-r border-hair bg-paper text-ink md:hidden"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        {/* Shift TopBar contents right on mobile so the hamburger
            sits in front of them without overlap. */}
        <div className="h-full pl-[56px] md:pl-0">{topbar}</div>
      </div>
      <aside
        className={clsx(
          'overflow-y-auto border-r border-hair bg-paper transition-transform duration-200',
          // mobile: off-canvas drawer
          'fixed left-0 top-[56px] z-40 h-[calc(100vh-56px)] w-[260px] -translate-x-full',
          // desktop: static column
          'md:static md:h-auto md:translate-x-0',
          open && 'translate-x-0',
        )}
      >
        {sidebar}
      </aside>
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 top-[56px] z-30 cursor-default bg-ink/30 md:hidden"
        />
      )}
      <main className="overflow-y-auto md:col-start-2">{children}</main>
    </div>
  );
}
