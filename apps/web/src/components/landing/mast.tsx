// Server component — fetches the live open-issues count from GitHub
// at request time (cached for an hour). The `revalidate` value plays
// nicely with the public REST API's 60-req/hour unauthenticated
// rate limit on a single deployment.

const GITHUB_REPO = 'mergecrew/mergecrew';

async function fetchOpenIssueCount(): Promise<number | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 3600 },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { open_issues_count?: number };
    return typeof body.open_issues_count === 'number' ? body.open_issues_count : null;
  } catch {
    return null;
  }
}

function formatDate(d: Date): string {
  // "Thursday, 21 May 2026" — matches the prototype's voice without
  // depending on the visitor's locale.
  const day = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${day}, ${date}`;
}

export async function Mast() {
  const openIssues = await fetchOpenIssueCount();
  const today = formatDate(new Date());
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-t border-ink bg-ink px-[36px] py-[10px] font-mono text-[11px] uppercase tracking-[0.1em] text-paper md:px-[80px]">
      <div className="flex flex-wrap items-center gap-x-[28px] gap-y-1">
        {openIssues != null && <span>Issue queue · {openIssues} open</span>}
        <span>{today}</span>
        <span>Apache 2.0 · Self-hostable · BYO LLM</span>
      </div>
      <div className="flex items-center gap-2 text-accent-soft">
        <span className="h-[6px] w-[6px] rounded-full bg-energy animate-pulse-energy" />
        github.com/{GITHUB_REPO} · early alpha
      </div>
    </div>
  );
}
