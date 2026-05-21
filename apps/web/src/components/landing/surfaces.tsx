'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { Label } from '@/components/ui';

type IconKind = 'fill' | 'empty' | 'accent' | 'now' | 'energy';
type Verdict = 'ok' | 'review' | 'defer';

const TIMELINE_ROWS: {
  when: string;
  icon: IconKind;
  t: string;
  badge?: string;
  badgeKind?: 'positive' | 'energy';
  m: string;
  now?: boolean;
}[] = [
  {
    when: '09:00:04',
    icon: 'fill',
    t: 'Planner drafted changeset',
    badge: '3 files · ~140 LOC',
    m: '"Fix calendar event drag — drop targets off-grid on mobile."',
  },
  {
    when: '09:04:31',
    icon: 'fill',
    t: 'Coder opened draft PR #418',
    badge: '+128 / -22',
    m: 'apps/web/calendar/EventCanvas.tsx · packages/ui/Grid.tsx',
  },
  {
    when: '09:11:08',
    icon: 'empty',
    t: 'Reviewer requested changes',
    badge: '1 of 2 loops',
    m: '"Hardcoded breakpoint — pull from design tokens."',
  },
  {
    when: '09:14:55',
    icon: 'fill',
    t: 'Coder revised — Reviewer approved',
    badge: '+4 / -3',
    badgeKind: 'positive',
    m: 'PR #418 marked ready-for-review',
  },
  {
    when: '09:18:02',
    icon: 'accent',
    t: 'Deploy → dev (Vercel)',
    badge: 'preview live',
    m: 'demo-saas-pr-418-mergecrew.vercel.app · 38s build',
  },
  {
    when: '09:22:17',
    icon: 'energy',
    t: 'Scanner found 1 regression',
    badge: 'filed 2026-05-22',
    badgeKind: 'energy',
    m: 'Console: TypeError in Sidebar.tsx after viewport < 640',
  },
  {
    when: '17:00:00',
    icon: 'now',
    t: 'Digest dispatched — awaiting your gate',
    now: true,
    m: '5 PRs · $0.74 spent · 1 regression carried forward',
  },
];

const DIGEST_PRS: { id: string; t: string; m: string; v: Verdict }[] = [
  { id: '#418', t: 'Fix calendar event drag — off-grid drop targets', m: 'apps/web · +132 / -25 · low risk', v: 'ok' },
  { id: '#419', t: 'Migrate billing tables to RLS policies', m: 'packages/db · +84 / -12 · review needed', v: 'review' },
  { id: '#420', t: 'Slack adapter — handle webhook retry storms', m: 'packages/adapters-comms · +41 / -8', v: 'ok' },
  { id: '#421', t: 'Docs: deploy-targets cookbook — Render section', m: 'docs/03-infrastructure · +280 / 0', v: 'ok' },
  { id: '#422', t: 'Worker-cron: backoff on rate-limit', m: 'apps/worker-cron · defer to Monday', v: 'defer' },
];

function ScreenChrome({ title, right }: { title: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-hair bg-bg-2 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2">
      <div className="flex gap-[6px]">
        <span className="h-[10px] w-[10px] rounded-full bg-hair-strong" />
        <span className="h-[10px] w-[10px] rounded-full bg-hair-strong" />
        <span className="h-[10px] w-[10px] rounded-full bg-hair-strong" />
      </div>
      <span className="truncate">{title}</span>
      <span className="ml-auto text-muted">{right}</span>
    </div>
  );
}

function IconBlock({ kind }: { kind: IconKind }) {
  return (
    <span
      className={clsx(
        'h-[12px] w-[12px] flex-shrink-0 border-[1.5px] border-ink',
        kind === 'fill' && 'bg-ink',
        kind === 'empty' && 'opacity-40',
        kind === 'accent' && 'border-accent bg-accent',
        kind === 'energy' && 'border-energy bg-energy',
        kind === 'now' && 'border-accent bg-accent animate-step-pulse',
      )}
    />
  );
}

export function Surfaces() {
  const [shipped, setShipped] = useState(false);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(() =>
    Object.fromEntries(DIGEST_PRS.map((p) => [p.id, p.v])) as Record<string, Verdict>,
  );

  const cycle = (id: string) => {
    if (shipped) return;
    setVerdicts((v) => {
      const order: Verdict[] = ['ok', 'review', 'defer'];
      const cur = v[id] ?? 'ok';
      return { ...v, [id]: order[(order.indexOf(cur) + 1) % order.length]! };
    });
  };

  return (
    <section id="surfaces" className="px-[36px] py-[100px] md:px-[80px] md:py-[120px]">
      <div className="mb-12 grid grid-cols-1 items-end gap-10 md:grid-cols-[1.2fr_1fr] md:gap-20">
        <div>
          <Label accent className="mb-[22px] block">
            004 — Surfaces
          </Label>
          <h2 className="m-0 text-[clamp(36px,6vw,76px)] font-medium leading-[0.96] tracking-[-0.04em]">
            A timeline of work,
            <br />
            not a <em className="not-italic text-accent">tab</em> of chats.
          </h2>
        </div>
        <div className="max-w-[660px] space-y-3 text-[16px] leading-[1.55] text-ink-2 md:text-[18px]">
          <p>
            Three things you&apos;ll actually open: today&apos;s timeline, the daily digest, and
            the approval card. The rest stays on the box — it does its job whether you&apos;re
            watching or not.
          </p>
          <p>
            No dashboards to learn. No tickets to triage. Just a verdict per day, delivered the way
            the news used to come.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
        {/* Timeline */}
        <div className="border border-hair bg-paper shadow-card">
          <ScreenChrome
            title="demo-org / demo-saas / timeline"
            right={
              <span className="flex items-center gap-2">
                <span className="h-[6px] w-[6px] rounded-full bg-positive animate-live-pulse" />
                14:22 UTC · today
              </span>
            }
          />
          <div className="px-5 py-4">
            {TIMELINE_ROWS.map((r) => (
              <div
                key={r.when}
                className={clsx(
                  'grid grid-cols-[78px_14px_1fr] items-start gap-3 border-b border-hair-2 py-[12px] text-[13px] last:border-0',
                  r.now && 'bg-accent-tint',
                )}
              >
                <div className="font-mono text-[11px] text-muted">{r.when}</div>
                <IconBlock kind={r.icon} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium tracking-[-0.005em] text-ink">
                    {r.t}
                    {r.badge && (
                      <span
                        className={clsx(
                          'inline-block px-[7px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em]',
                          r.badgeKind === 'positive' && 'bg-positive-soft text-positive-deep',
                          r.badgeKind === 'energy' && 'bg-energy-soft text-energy-deep',
                          !r.badgeKind && 'bg-bg text-ink-2',
                        )}
                      >
                        {r.badge}
                      </span>
                    )}
                  </div>
                  <div className="mt-[3px] text-[12.5px] leading-[1.55] text-ink-2">{r.m}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Digest */}
        <div className="border border-hair bg-paper shadow-card">
          <ScreenChrome
            title="today's digest · 22 May"
            right={shipped ? 'shipped' : 'awaiting decision'}
          />
          <div className="px-5 py-5">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="m-0 text-[19px] font-medium tracking-[-0.015em]">
                The crew shipped 5 PRs today.
              </h4>
              <span className="font-mono text-[11px] text-muted">17:00 UTC</span>
            </div>
            <div className="mt-3 border-l-[3px] border-accent bg-accent-tint px-[14px] py-[12px] text-[13.5px] leading-[1.6] text-ink-2">
              <b className="text-ink">Net result:</b> four are ready to ship, one needs your eyes —
              Scanner flagged a viewport regression carried forward to tomorrow. Daily spend{' '}
              <b className="text-ink">$0.74</b>, 92% of weekly budget remaining.
            </div>
            {DIGEST_PRS.map((p) => {
              const v = verdicts[p.id] ?? 'ok';
              const label = v === 'ok' ? 'Ship' : v === 'review' ? 'Review' : 'Defer';
              return (
                <div
                  key={p.id}
                  className="mt-3 grid grid-cols-[54px_1fr_auto] items-center gap-3 border-b border-hair-2 pb-3 text-[13px] last:border-0"
                >
                  <span className="font-mono text-[12px] font-semibold text-ink">{p.id}</span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium tracking-[-0.005em]">{p.t}</div>
                    <div className="mt-[2px] font-mono text-[11.5px] text-muted">{p.m}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => cycle(p.id)}
                    className={clsx(
                      'inline-block min-w-[56px] cursor-pointer border px-[10px] py-[5px] font-mono text-[11px] uppercase tracking-[0.06em] transition-colors',
                      v === 'ok' && 'border-positive bg-positive-soft text-positive-deep hover:bg-positive hover:text-paper',
                      v === 'review' && 'border-energy bg-energy-soft text-energy-deep hover:bg-energy hover:text-paper',
                      v === 'defer' && 'border-hair-strong bg-bg-2 text-ink-2 hover:bg-bg',
                      shipped && 'pointer-events-none opacity-70',
                    )}
                    title="click to change"
                  >
                    {label}
                  </button>
                </div>
              );
            })}
            <div
              className={clsx(
                'relative mt-[18px] flex flex-wrap items-center justify-between gap-4 overflow-hidden p-[18px] text-paper transition-colors',
                shipped ? 'bg-positive-deep' : 'bg-ink',
              )}
            >
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-transparent to-accent/[0.22]" />
              <div className="relative z-[2] max-w-[400px] text-[13.5px] leading-[1.55]">
                <div
                  className={clsx(
                    'mb-[4px] font-mono text-[11px] uppercase tracking-[0.08em]',
                    shipped ? 'text-positive-soft' : 'text-energy',
                  )}
                >
                  {shipped ? '✓ Shipped to production' : 'Approval required'}
                </div>
                {shipped
                  ? '4 PRs promoted. Scanner re-runs tomorrow on the carried regression. Tagged v0.4.142.'
                  : 'Promote 4 PRs to production. Defer 1. Re-run Scanner tomorrow on the carried regression.'}
              </div>
              <div className="relative z-[2] flex gap-2">
                {!shipped && (
                  <button
                    type="button"
                    onClick={() => setShipped(true)}
                    className="cursor-pointer border border-paper/40 bg-transparent px-4 py-[10px] text-[12.5px] font-medium text-paper transition-colors hover:bg-paper/10"
                  >
                    Defer all
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShipped(true)}
                  className={clsx(
                    'cursor-pointer border px-4 py-[10px] text-[12.5px] font-medium transition-colors',
                    shipped
                      ? 'pointer-events-none border-paper bg-paper font-semibold text-positive-deep'
                      : 'border-energy bg-energy text-white hover:bg-energy-deep',
                  )}
                >
                  {shipped ? '✓ Shipped' : 'Ship → prod'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
