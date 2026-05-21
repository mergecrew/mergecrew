'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

type NavGroup = { label: string; items: { id: string; label: string }[] };

export function SettingsLayout({ nav, children }: { nav: NavGroup[]; children: ReactNode }) {
  const firstId = nav[0]?.items[0]?.id;
  const [active, setActive] = useState<string | undefined>(firstId);

  useEffect(() => {
    const ids = nav.flatMap((g) => g.items.map((i) => i.id));
    if (ids.length === 0) return;

    const onScroll = () => {
      let best = ids[0]!;
      let bestTop = Infinity;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // The element with the smallest |top| while still above the 140px
        // anchor wins. This matches the prototype's scroll-spy heuristic.
        if (r.top <= 140 && r.top > -r.height && Math.abs(r.top) < bestTop) {
          best = id;
          bestTop = Math.abs(r.top);
        }
      }
      setActive(best);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [nav]);

  return (
    <div className="grid grid-cols-1 items-start gap-9 md:grid-cols-[220px_1fr]">
      <nav className="sticky top-6 self-start py-1">
        {nav.map((group) => (
          <div key={group.label}>
            <div className="px-3 pt-4 pb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              {group.label}
            </div>
            {group.items.map((it) => (
              <a
                key={it.id}
                href={`#${it.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(it.id);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className={clsx(
                  'block px-3 py-[7px] border-l-2 text-[13.5px] no-underline transition-colors',
                  active === it.id
                    ? 'border-accent bg-accent-tint text-accent-deep font-medium'
                    : 'border-transparent text-ink-2 hover:bg-paper hover:text-ink',
                )}
              >
                {it.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex max-w-[940px] flex-col gap-14">{children}</div>
    </div>
  );
}

export function Section({
  id,
  anchor,
  title,
  desc,
  children,
}: {
  id: string;
  anchor?: string;
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-[18px] border-b border-hair pb-[14px]">
        {anchor && (
          <div className="mb-[6px] font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
            {anchor}
          </div>
        )}
        <h2 className="m-0 text-[24px] font-medium tracking-[-0.025em]">{title}</h2>
        {desc && (
          <p className="mt-2 max-w-[720px] text-[14px] leading-[1.55] text-ink-2">{desc}</p>
        )}
      </div>
      {children}
    </section>
  );
}
