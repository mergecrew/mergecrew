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
    <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[220px_1fr] md:gap-9">
      {/* Mobile: horizontally scrollable chip strip pinned to the top
          of the content. Desktop: vertical sticky rail. The mobile
          variant intentionally doesn't stick — sticking on phones
          covers the actual content (#722). */}
      <nav className="-mx-4 self-start overflow-x-auto md:sticky md:top-6 md:mx-0 md:overflow-visible md:py-1">
        <div className="flex gap-2 px-4 py-2 md:flex-col md:gap-0 md:px-0 md:py-0">
          {nav.map((group) => (
            <div key={group.label} className="flex shrink-0 items-center gap-2 md:block md:shrink">
              <div className="hidden px-3 pt-4 pb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted md:block">
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
                    'no-underline transition-colors whitespace-nowrap',
                    // Mobile: pill chips
                    'border px-3 py-[6px] text-[12px]',
                    // Desktop: left-rail items with accent indicator
                    'md:block md:whitespace-normal md:border-0 md:border-l-2 md:px-3 md:py-[7px] md:text-[13.5px]',
                    active === it.id
                      ? 'border-accent bg-accent-tint text-accent-deep md:font-medium'
                      : 'border-hair text-ink-2 hover:bg-paper md:border-transparent md:hover:text-ink',
                  )}
                >
                  {it.label}
                </a>
              ))}
            </div>
          ))}
        </div>
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
