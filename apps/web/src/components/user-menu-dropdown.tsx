'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, Check, Plus } from 'lucide-react';
import { clsx } from 'clsx';

type Org = { slug: string; name: string };

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
        className="flex items-center gap-1.5 rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <span className="hidden max-w-[180px] truncate sm:inline">{label}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="truncate font-medium">{label}</div>
            {email && email !== label && (
              <div className="truncate text-xs text-zinc-500">{email}</div>
            )}
          </div>

          {orgs.length > 0 && (
            <div className="border-b border-zinc-200 py-1 dark:border-zinc-800">
              <div className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Organization
              </div>
              <ul>
                {orgs.map((o) => {
                  const isCurrent = o.slug === currentOrgSlug;
                  return (
                    <li key={o.slug}>
                      <Link
                        href={`/orgs/${o.slug}`}
                        onClick={() => setOpen(false)}
                        className={clsx(
                          'flex items-center justify-between gap-2 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800',
                          isCurrent && 'font-medium',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{o.name}</span>
                        {isCurrent && (
                          <Check size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                        )}
                      </Link>
                    </li>
                  );
                })}
                <li>
                  <Link
                    href="/orgs/new"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 px-4 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  >
                    <Plus size={14} aria-hidden />
                    <span>New organization</span>
                  </Link>
                </li>
              </ul>
            </div>
          )}

          {currentOrgSlug && (
            <div className="border-b border-zinc-200 py-1 dark:border-zinc-800">
              <Link
                href={`/orgs/${currentOrgSlug}/settings`}
                onClick={() => setOpen(false)}
                className="block px-4 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Organization settings
              </Link>
            </div>
          )}

          <div className="border-b border-zinc-200 py-1 dark:border-zinc-800">
            <Link
              href="/account/security"
              onClick={() => setOpen(false)}
              className="block px-4 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Account security
            </Link>
          </div>

          {signOutSlot}
        </div>
      )}
    </div>
  );
}
