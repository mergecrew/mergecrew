'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Plus } from 'lucide-react';
import { clsx } from 'clsx';

type Org = { slug: string; name: string };

function initialsOf(label: string): string {
  return label
    .split(/[\s@]+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('');
}

export function UserMenuDropdown({
  label,
  email,
  orgs,
  currentOrgSlug,
  signOutSlot,
}: {
  label: string;
  email?: string;
  orgs: Org[];
  currentOrgSlug?: string;
  /** Server-rendered <form action={signOut}> from the parent. */
  signOutSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initials = initialsOf(label || email || '?');

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className={clsx(
          'flex h-[32px] w-[32px] items-center justify-center rounded-full border-2 border-paper bg-gradient-to-br from-accent to-accent-deep text-[12.5px] font-semibold text-paper shadow-[0_0_0_1px_var(--hair-strong)] transition-shadow',
          open && 'shadow-[0_0_0_3px_var(--accent-soft)]',
        )}
      >
        {initials || '?'}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-[280px] overflow-hidden border border-hair bg-paper shadow-pop"
        >
          <div className="border-b border-hair-2 px-4 py-3">
            <div className="truncate text-[14px] font-medium tracking-[-0.005em] text-ink">
              {label}
            </div>
            {email && email !== label && (
              <div className="truncate font-mono text-[11.5px] text-muted">{email}</div>
            )}
          </div>

          {orgs.length > 0 && (
            <div className="border-b border-hair-2 py-1">
              <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                Organisation
              </div>
              <ul className="m-0 list-none p-0">
                {orgs.map((o) => {
                  const isCurrent = o.slug === currentOrgSlug;
                  return (
                    <li key={o.slug}>
                      <Link
                        href={`/orgs/${o.slug}`}
                        onClick={() => setOpen(false)}
                        className={clsx(
                          'flex items-center justify-between gap-2 px-4 py-[7px] text-[13px] no-underline text-ink-2 hover:bg-paper-2 hover:text-ink',
                          isCurrent && 'bg-accent-tint font-medium text-accent-deep',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{o.name}</span>
                        {isCurrent && (
                          <Check size={14} className="shrink-0 text-accent" aria-hidden />
                        )}
                      </Link>
                    </li>
                  );
                })}
                <li>
                  <Link
                    href="/orgs/new"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 px-4 py-[7px] text-[13px] text-muted no-underline hover:bg-paper-2 hover:text-ink"
                  >
                    <Plus size={14} aria-hidden />
                    <span>New organisation</span>
                  </Link>
                </li>
              </ul>
            </div>
          )}

          <div className="border-b border-hair-2 py-1">
            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className="block px-4 py-[7px] text-[13px] text-ink-2 no-underline hover:bg-paper-2 hover:text-ink"
            >
              Account preferences
            </Link>
            <Link
              href="/account#two-factor"
              onClick={() => setOpen(false)}
              className="block px-4 py-[7px] text-[13px] text-ink-2 no-underline hover:bg-paper-2 hover:text-ink"
            >
              Two-factor + sessions
            </Link>
            {currentOrgSlug && (
              <Link
                href={`/orgs/${currentOrgSlug}/settings`}
                onClick={() => setOpen(false)}
                className="block px-4 py-[7px] text-[13px] text-ink-2 no-underline hover:bg-paper-2 hover:text-ink"
              >
                Org settings
              </Link>
            )}
          </div>

          <div className="py-1">{signOutSlot}</div>
        </div>
      )}
    </div>
  );
}
