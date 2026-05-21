import Link from 'next/link';
import { Wordmark } from '@/components/ui';

const COLS = [
  {
    h: 'Product',
    links: [
      { href: '#crew', label: 'The crew' },
      { href: '#loop', label: 'The loop' },
      { href: '#surfaces', label: 'Surfaces' },
      {
        href: 'https://github.com/mergecrew/mergecrew/tree/main/docs/01-design',
        label: 'Lifecycle templates',
      },
    ],
  },
  {
    h: 'Engineering',
    links: [
      {
        href: 'https://github.com/mergecrew/mergecrew/tree/main/docs/02-architecture',
        label: 'Architecture',
      },
      {
        href: 'https://github.com/mergecrew/mergecrew/blob/main/docs/openapi.json',
        label: 'Spec set',
      },
      {
        href: 'https://github.com/mergecrew/mergecrew/tree/main/docs/03-infrastructure',
        label: 'Deploy cookbook',
      },
      { href: 'https://github.com/mergecrew/mergecrew/tree/main/sdks', label: 'Adapters SDK' },
    ],
  },
  {
    h: 'Community',
    links: [
      { href: 'https://github.com/mergecrew/mergecrew', label: 'GitHub' },
      { href: 'https://github.com/orgs/mergecrew/projects/1', label: 'Roadmap' },
      { href: 'https://github.com/mergecrew/mergecrew/discussions', label: 'Discussions' },
      { href: 'https://github.com/mergecrew/mergecrew/blob/main/SPONSORS.md', label: 'Sponsors' },
    ],
  },
];

export function Footer() {
  return (
    <>
      <footer className="grid grid-cols-1 gap-10 border-t border-hair px-[36px] py-[80px] md:grid-cols-[1.5fr_1fr_1fr_1fr] md:gap-12 md:px-[80px]">
        <div className="max-w-[400px]">
          <Wordmark withTag={false} />
          <p className="mt-6 text-[14px] leading-[1.6] text-ink-2">
            The autonomous SDLC. Built in the open. Apache 2.0. Not yet recommended for production
            tenants — but it ships its own PRs every weekday.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.h}>
            <h5 className="mb-4 m-0 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              {c.h}
            </h5>
            <ul className="space-y-2 m-0 list-none p-0">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-[13.5px] text-ink-2 no-underline hover:text-accent"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </footer>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hair-2 bg-paper px-[36px] py-[14px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted md:px-[80px]">
        <span>Mergecrew · Apache 2.0 · v0.4-alpha</span>
        <span>Built in the open · github.com/mergecrew</span>
      </div>
    </>
  );
}
