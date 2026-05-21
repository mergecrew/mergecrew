import { clsx } from 'clsx';
import { Label } from '@/components/ui';

type CrewMember = {
  idx: string;
  tag: string;
  glyph: string;
  role: string;
  desc: string;
  stats: [string, string][];
  accent?: boolean;
  gate?: boolean;
};

const CREW: CrewMember[] = [
  {
    idx: '01',
    tag: 'Active',
    glyph: 'P',
    role: 'Planner',
    desc: "Reads recent intent, yesterday's digest, and the repo itself. Drafts small, focused changesets. Never a five-day epic.",
    stats: [
      ['~2', 'TASKS / DAY'],
      ['180', 'SEC AVG'],
    ],
  },
  {
    idx: '02',
    tag: 'Active',
    glyph: 'C',
    role: 'Coder',
    accent: true,
    desc: 'Opens PRs against your real branch. Touches only the files the Planner pointed at. No scope creep, no half-finished refactors.',
    stats: [
      ['~140', 'LOC / PR'],
      ['1', 'BRANCH / RUN'],
    ],
  },
  {
    idx: '03',
    tag: 'Active',
    glyph: 'R',
    role: 'Reviewer',
    desc: 'A cheaper model catches the obvious before you do. Loops back to Coder on request-changes. You read fewer bad PRs.',
    stats: [
      ['3.1×', 'CHEAPER'],
      ['2', 'LOOPS MAX'],
    ],
  },
  {
    idx: '04',
    tag: 'Active',
    glyph: 'S',
    role: 'Scanner',
    desc: "Hits the dev preview with a curated checklist. Console errors, broken flows, regressions — filed back as tomorrow's tasks.",
    stats: [
      ['14', 'PROBES'],
      ['preview', 'ENV'],
    ],
  },
  {
    idx: '05',
    tag: 'Gate',
    glyph: '◆',
    role: 'Human',
    gate: true,
    desc: 'One decision per day. Approve to prod, defer, or roll back. Promotion to production is an invariant, never a setting.',
    stats: [
      ['1', 'DECISION / DAY'],
      ['~3', 'MIN AVG'],
    ],
  },
];

export function Crew() {
  return (
    <section id="crew" className="px-[36px] py-[100px] md:px-[80px] md:py-[120px]">
      <div className="mb-12 grid grid-cols-1 items-end gap-10 md:grid-cols-[1.2fr_1fr] md:gap-20">
        <div>
          <Label accent className="mb-[22px] block">
            002 — The Crew
          </Label>
          <h2 className="m-0 text-[clamp(36px,6vw,84px)] font-medium leading-[0.96] tracking-[-0.04em]">
            Five specialists.
            <br />
            One <em className="not-italic text-accent">weekday.</em>
          </h2>
        </div>
        <p className="max-w-[660px] text-[16px] leading-[1.55] text-ink-2 md:text-[18px]">
          Four agents specialize, one human gates. A cheaper Reviewer catches the obvious before you
          do, so you read fewer bad PRs. Promotion to prod is the only step Mergecrew will never
          automate — by design, not by configuration.
        </p>
      </div>

      <div className="grid grid-cols-1 border-b border-hair border-t-2 border-t-ink sm:grid-cols-2 lg:grid-cols-5">
        {CREW.map((c, i) => (
          <div
            key={c.idx}
            className={clsx(
              'flex min-h-[400px] flex-col gap-4 px-6 py-[30px] transition-colors',
              i < CREW.length - 1 && 'border-b border-r-0 border-hair sm:border-r lg:border-b-0',
              c.gate ? 'bg-paper' : 'bg-bg hover:bg-paper',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                CREW · {c.idx}
              </span>
              <span
                className={clsx(
                  'px-[7px] py-1 font-mono text-[10px] uppercase tracking-[0.08em]',
                  c.gate ? 'bg-energy text-paper' : 'bg-accent-soft text-accent-deep',
                )}
              >
                {c.tag}
              </span>
            </div>
            <div
              className={clsx(
                'flex h-[122px] items-center justify-center border',
                c.gate ? 'border-accent bg-accent' : 'border-hair bg-paper',
              )}
            >
              <span
                className={clsx(
                  'font-mono text-[64px] font-light leading-none tracking-[-0.05em]',
                  c.gate ? 'text-paper' : c.accent ? 'text-accent' : 'text-ink',
                )}
              >
                {c.glyph}
              </span>
            </div>
            <div className="text-[26px] font-medium leading-none tracking-[-0.025em]">{c.role}</div>
            <div className="text-[13.5px] leading-[1.55] text-ink-2">{c.desc}</div>
            <div className="mt-auto flex gap-4 border-t border-hair pt-[14px] font-mono text-[10.5px] tracking-[0.05em] text-muted">
              {c.stats.map(([b, l]) => (
                <span key={l}>
                  <b className="font-semibold text-ink">{b}</b> {l}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
