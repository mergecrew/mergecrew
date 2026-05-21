'use client';

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Label } from '@/components/ui';

const STAGES = [
  {
    num: '01 · 09:00',
    h: 'Spec',
    p: "Planner reads intent, the repo, and yesterday's bugs. Drafts a small changeset.",
  },
  {
    num: '02 · 09:04',
    h: 'Build',
    p: 'Coder opens a draft PR. Reviewer loops back on request-changes.',
  },
  {
    num: '03 · 09:18',
    h: 'Deploy',
    p: 'Pluggable adapter ships the PR to dev — Vercel, Fly, GH Actions.',
  },
  {
    num: '04 · 09:22',
    h: 'Scan',
    p: 'Scanner exercises the preview URL. Regressions filed for tomorrow.',
  },
  {
    num: '05 · 17:00',
    h: 'Digest',
    p: "One email. Today's diffs, today's risks, today's verdict.",
  },
  {
    num: '06 · GATE',
    h: 'Human',
    p: "Approve, defer, or roll back. The only step Mergecrew won't automate.",
    gate: true,
  },
  {
    num: '07 · SHIP',
    h: 'Prod',
    p: 'Promoted on your nod. Tagged, deployed, archived in the run log.',
    prod: true,
  },
];

export function Loop() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!ref.current || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(ref.current);
    const fallback = setTimeout(() => setSeen(true), 1600);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    let i = 0;
    const t = setInterval(() => {
      setActive(i);
      i = (i + 1) % (STAGES.length + 2);
    }, 700);
    return () => clearInterval(t);
  }, [seen]);

  const pct = active < 0 ? 0 : Math.min(100, ((active + 1) / STAGES.length) * 100);

  return (
    <section
      id="loop"
      className="relative overflow-hidden bg-ink px-[36px] py-[100px] text-paper md:px-[80px] md:py-[120px]"
    >
      <div
        className="pointer-events-none absolute inset-0
          bg-[radial-gradient(circle_700px_at_90%_0%,rgba(14,91,201,0.18),transparent_60%),radial-gradient(circle_500px_at_10%_100%,rgba(255,77,84,0.10),transparent_60%)]"
      />

      <div className="relative mb-14 grid grid-cols-1 items-end gap-10 md:grid-cols-[1.2fr_1fr] md:gap-20">
        <div>
          <Label className="mb-[22px] block text-accent-soft">003 — The Loop</Label>
          <h2 className="m-0 text-[clamp(36px,6vw,76px)] font-medium leading-[0.96] tracking-[-0.04em]">
            Not an agent.
            <br />
            An <em className="not-italic text-accent-soft">assembly line.</em>
          </h2>
        </div>
        <p className="max-w-[660px] text-[16px] leading-[1.55] text-paper/70 md:text-[18px]">
          Most autonomous-coding tools take a ticket and produce a PR. Mergecrew owns the entire
          cycle around that work — runs it daily, deploys it, scans it, and hands you a single
          moment of judgment per day.
        </p>
      </div>

      <div ref={ref} className="relative grid grid-cols-1 border border-paper/20 md:grid-cols-7">
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] border-r-2 border-accent"
          style={{
            width: `${pct}%`,
            background: 'linear-gradient(90deg, transparent, rgba(14,91,201,0.18))',
            transition: 'width 0.8s cubic-bezier(.7,.2,.2,1)',
          }}
        />
        {STAGES.map((s, i) => (
          <div
            key={s.h}
            className={clsx(
              'relative z-[2] border-b border-paper/20 px-[22px] py-[30px] last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0',
              s.gate && 'bg-accent',
              s.prod && 'bg-energy text-white',
            )}
          >
            <div className="flex items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.12em] text-paper/45">
              <span
                className={clsx(
                  'h-[6px] w-[6px] rounded-full',
                  i === active ? 'bg-accent animate-step-pulse' : 'bg-accent-soft',
                )}
              />
              {s.num}
            </div>
            <h3 className="mb-[10px] mt-[14px] text-[22px] font-medium tracking-[-0.025em] md:text-[25px]">
              {s.h}
            </h3>
            <p className="m-0 text-[13.5px] leading-[1.5] text-paper/70">{s.p}</p>
          </div>
        ))}
      </div>

      <div className="relative mt-7 flex flex-wrap items-center justify-between gap-6 border border-paper/20 px-6 py-[18px]">
        <div className="max-w-[700px] text-[14px] leading-[1.45] text-paper/75">
          <b className="text-paper">Product invariant.</b> Production promotion is always a human
          decision. Not a setting — a property of the system. Try to disable it; the build fails.
        </div>
        <div className="flex shrink-0 flex-wrap gap-x-7 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-paper/50">
          <span>
            median runtime <b className="font-medium text-accent-soft">22m</b>
          </span>
          <span>
            cost <b className="font-medium text-accent-soft">$0.74</b>
          </span>
          <span>
            demo mode <b className="font-medium text-accent-soft">$0.00</b>
          </span>
        </div>
      </div>
    </section>
  );
}
