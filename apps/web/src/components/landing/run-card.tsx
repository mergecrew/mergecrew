'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

const STEPS = [
  { name: 'Planner · spec', when: '09:00' },
  { name: 'Coder · draft PR', when: '09:04' },
  { name: 'Reviewer · approve', when: '09:14' },
  { name: 'Deploy · to dev', when: '09:18' },
  { name: 'Scanner · probe', when: '09:22' },
  { name: 'Digest · pending', when: '17:00' },
];

export function RunCard() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setActive((a) => (a + 1) % (STEPS.length + 2));
    }, 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="rotate-[0.6deg] border border-ink bg-paper shadow-card transition-transform duration-200 hover:rotate-0">
      <div className="flex items-center justify-between border-b border-hair bg-bg-2 px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
          demo-saas · today&apos;s run
        </span>
        <span className="flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-positive-deep">
          <span className="h-[6px] w-[6px] rounded-full bg-positive animate-live-pulse" />
          live · {Math.min(active, STEPS.length)} of {STEPS.length}
        </span>
      </div>
      <div className="px-5 py-[18px]">
        <div className="mb-[14px] text-[16px] font-medium tracking-[-0.015em]">
          PR #418 · Fix calendar event drag — off-grid drops
        </div>
        {STEPS.map((s, i) => {
          const allDone = active >= STEPS.length;
          const cls = allDone || i < active ? 'done' : i === active ? 'active' : 'pending';
          return (
            <div
              key={s.name}
              className="flex items-center gap-3 border-b border-dashed border-hair py-[9px] text-[13.5px] last:border-0"
            >
              <span
                className={clsx(
                  'h-[14px] w-[14px] flex-shrink-0 border-[1.5px] border-ink transition-all duration-300',
                  cls === 'done' && 'bg-ink',
                  cls === 'active' && 'border-accent bg-accent animate-step-pulse',
                  cls === 'pending' && 'opacity-35',
                )}
              />
              <span className={clsx('flex-1 font-medium', cls === 'pending' && 'text-muted')}>
                {s.name}
              </span>
              <span className={clsx('font-mono text-[11px]', cls === 'active' ? 'text-accent' : 'text-muted')}>
                {s.when}
              </span>
            </div>
          );
        })}
        <div className="mt-[14px] flex justify-between border-t border-hair pt-[14px] font-mono text-[11px] tracking-[0.04em] text-muted">
          <span>+128 / -22 · 3 files</span>
          <span>
            <b className="font-semibold text-ink">$0.74</b> spent
          </span>
        </div>
      </div>
    </div>
  );
}
