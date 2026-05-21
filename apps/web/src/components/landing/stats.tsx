import { clsx } from 'clsx';

const STATS = [
  { k: 'Cadence', v: '1 / weekday', n: 'No tickets, no chat. The crew shows up.' },
  {
    k: 'Median PR',
    v: '137 LOC',
    n: 'Small. Focused. Reviewable. Never a five-day epic.',
    tone: 'accent' as const,
  },
  {
    k: 'Cost / run',
    v: '$0.74',
    n: 'Capability-routed, with provider fallover.',
    tone: 'energy' as const,
  },
  { k: 'Decisions / day', v: '1', n: 'One inbox. One verdict. The only non-automated step.' },
];

export function Stats() {
  return (
    <div className="mx-[36px] grid grid-cols-2 border-b border-t border-hair md:mx-[80px] md:grid-cols-4">
      {STATS.map((s, i) => (
        <div
          key={s.k}
          className={clsx(
            'border-hair px-[26px] py-[28px]',
            i < STATS.length - 1 && 'border-r',
            i < STATS.length - 2 && 'border-b md:border-b-0',
          )}
        >
          <span className="block font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{s.k}</span>
          <div
            className={clsx(
              'mt-[14px] text-[40px] font-medium leading-none tracking-[-0.035em]',
              s.tone === 'accent' && 'text-accent',
              s.tone === 'energy' && 'text-energy-deep',
            )}
          >
            {s.v}
          </div>
          <div className="mt-3 text-[13.5px] leading-[1.5] text-ink-2">{s.n}</div>
        </div>
      ))}
    </div>
  );
}
