import Link from 'next/link';
import { Arrow, LinkButton, Label } from '@/components/ui';
import { RunCard } from './run-card';

export function Hero() {
  return (
    <section className="relative px-[36px] py-[100px] md:px-[80px] md:pb-[140px] md:pt-[180px]">
      <div className="mb-9 flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="font-mono text-[13px] font-semibold tracking-[0.12em] text-accent">001</span>
        <Label className="!text-ink">Manifesto</Label>
        <Label>An autonomous SDLC, not another agent chat.</Label>
      </div>
      <h1 className="m-0 max-w-[1300px] text-[clamp(48px,8vw,120px)] font-medium leading-[0.92] tracking-[-0.045em]">
        The product team
        <br />
        that doesn&apos;t need <em className="not-italic text-accent">standup.</em>
      </h1>
      <div className="mt-14 grid grid-cols-1 items-start gap-12 md:grid-cols-[1.3fr_1fr] md:gap-16">
        <div>
          <p className="max-w-[640px] text-[18px] leading-[1.5] text-ink-2 md:text-[21px]">
            Mergecrew is a multi-agent crew that runs on a cron against your real repository.{' '}
            <b>Spec, build, deploy to dev, scan for regressions</b> — every weekday by lunch. One
            decision arrives in your inbox at 5pm: promote to production, or don&apos;t.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-[14px]">
            <LinkButton href="/login" variant="accent" size="lg">
              Run the loop locally <Arrow />
            </LinkButton>
            <Link
              href="#loop"
              className="inline-flex items-center gap-2 border border-ink bg-transparent px-[20px] py-[13px] text-[14.5px] font-medium leading-none text-ink no-underline transition-[transform,background-color] duration-100 hover:-translate-y-[1px] hover:bg-paper"
            >
              Read the spec
            </Link>
            <span className="text-[12.5px] text-muted">
              or{' '}
              <code className="font-mono text-[12.5px] text-ink-2">
                docker compose -f docker-compose.full.yml up
              </code>
            </span>
          </div>
        </div>
        <RunCard />
      </div>
    </section>
  );
}
