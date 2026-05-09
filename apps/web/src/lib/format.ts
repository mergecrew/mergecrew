export function relativeTime(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const ms = Date.now() - d.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return s <= 5 ? 'just now' : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function runStatusToDot(
  status: string,
): 'running' | 'paused' | 'idle' | 'failed' | 'done' {
  if (status === 'running') return 'running';
  if (status === 'paused_rate_limit' || status === 'paused_gate' || status === 'paused') return 'paused';
  if (status === 'failed') return 'failed';
  if (status === 'done' || status === 'completed' || status === 'succeeded') return 'done';
  return 'idle';
}
