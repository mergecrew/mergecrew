export function Mast() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-t border-ink bg-ink px-[36px] py-[10px] font-mono text-[11px] uppercase tracking-[0.1em] text-paper md:px-[80px]">
      <div className="flex flex-wrap items-center gap-x-[28px] gap-y-1">
        <span>Issue No. 142</span>
        <span>Thursday, 21 May 2026</span>
        <span>Apache 2.0 · Self-hostable · BYO LLM</span>
      </div>
      <div className="flex items-center gap-2 text-accent-soft">
        <span className="h-[6px] w-[6px] rounded-full bg-energy animate-pulse-energy" />
        Shipping its own PRs since v0.1.
      </div>
    </div>
  );
}
