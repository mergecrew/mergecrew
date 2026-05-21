import { Arrow, Label, LinkButton } from '@/components/ui';

export function Quickstart() {
  return (
    <section
      id="quickstart"
      className="grid grid-cols-1 items-center gap-12 px-[36px] py-[100px] md:grid-cols-[1fr_1.05fr] md:gap-16 md:px-[80px] md:py-[120px]"
    >
      <div>
        <Label accent className="mb-[22px] block">
          005 — Self-host
        </Label>
        <h2 className="m-0 text-[clamp(36px,6vw,76px)] font-medium leading-[0.96] tracking-[-0.04em]">
          Five minutes.
          <br />
          No card. <em className="not-italic text-accent">No key.</em>
        </h2>
        <div className="mt-6 max-w-[520px] space-y-4 text-[16px] leading-[1.55] text-ink-2 md:text-[17px]">
          <p>
            One <code className="font-mono text-[14px] text-ink">docker compose</code> brings up
            Postgres, Redis, four backend services, and the web app. The seeded demo project runs
            the full multi-agent loop against a deterministic stub.
          </p>
          <p>
            No LLM provider required to see the loop end-to-end. When you&apos;re ready, plug in
            Anthropic, OpenAI, Bedrock, or local Ollama and flip{' '}
            <code className="font-mono text-[14px] text-ink">MERGECREW_DEMO_MODE=0</code>.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-[14px]">
          <LinkButton
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/00-quickstart.md"
            variant="energy"
            size="lg"
          >
            Read the quickstart <Arrow />
          </LinkButton>
          <LinkButton href="https://github.com/mergecrew/mergecrew" variant="ghost" size="lg">
            Star on GitHub
          </LinkButton>
        </div>
      </div>

      <div className="border border-ink bg-ink text-paper shadow-card">
        <div className="flex items-center gap-3 border-b border-paper/20 bg-ink-2 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-paper/70">
          <div className="flex gap-[6px]">
            <span className="h-[10px] w-[10px] rounded-full bg-paper/40" />
            <span className="h-[10px] w-[10px] rounded-full bg-paper/40" />
            <span className="h-[10px] w-[10px] rounded-full bg-paper/40" />
          </div>
          <span>~ / projects / mergecrew</span>
          <span className="ml-auto">zsh · 80×24</span>
        </div>
        <pre className="m-0 overflow-x-auto p-5 font-mono text-[13px] leading-[1.6] text-paper">
{`# 1. Clone & spin up everything
$ git clone https://github.com/mergecrew/mergecrew.git
$ cd mergecrew
$ pnpm compose:full

# 2. localhost:3000 — already signed in
✓ postgres      ready
✓ redis         ready
✓ api · 4000    ready
✓ orchestrator  ready
✓ runner        ready
✓ worker-cron   ready
✓ web · 3000    ready

# 3. Trigger today's run
$ curl -X POST localhost:4000/v1/orgs/demo/projects/demo-saas/runs
`}
          <span className="text-energy">→ run accepted · agent_steps streaming</span>
          <span className="ml-[2px] inline-block h-[14px] w-[8px] translate-y-[2px] bg-energy animate-blink" />
        </pre>
      </div>
    </section>
  );
}
