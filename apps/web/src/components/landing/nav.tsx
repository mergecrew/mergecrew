'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Wordmark, LinkButton, Arrow } from '@/components/ui';

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={clsx(
        'sticky top-0 z-50 flex items-center justify-between px-[36px] py-[22px] md:px-[80px]',
        'backdrop-blur-md backdrop-saturate-[140%] transition-[border-color,background]',
        'border-b',
        scrolled ? 'border-hair bg-bg/90' : 'border-transparent bg-bg/80',
      )}
    >
      <Wordmark withTag />
      <div className="flex items-center gap-3 md:gap-8">
        <Link href="#crew" className="hidden text-[14px] font-medium text-ink-2 no-underline hover:text-accent md:inline">
          Crew
        </Link>
        <Link href="#loop" className="hidden text-[14px] font-medium text-ink-2 no-underline hover:text-accent md:inline">
          The Loop
        </Link>
        <Link href="#surfaces" className="hidden text-[14px] font-medium text-ink-2 no-underline hover:text-accent md:inline">
          Surfaces
        </Link>
        <Link
          href="#quickstart"
          className="hidden text-[14px] font-medium text-ink-2 no-underline hover:text-accent md:inline"
        >
          Self-host
        </Link>
        <a
          href="https://github.com/mergecrew/mergecrew"
          className="hidden text-[14px] font-medium text-ink-2 no-underline hover:text-accent md:inline"
        >
          GitHub
        </a>
        <LinkButton href="/login" variant="ghost" size="md">
          Sign in <Arrow />
        </LinkButton>
      </div>
    </nav>
  );
}
