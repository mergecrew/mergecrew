/**
 * Host allowlist matcher for the egress proxy (#575). Same semantics
 * as the runner-dns service and the Node skill layer so all three
 * agree on what's allowed.
 *
 * Kept self-contained (no workspace imports) so the proxy is a tiny
 * independent service.
 */

const PRIVATE_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const lowered = host.toLowerCase();
  if (PRIVATE_HOSTS.test(lowered)) return false;
  for (const raw of allowlist) {
    const pattern = raw.toLowerCase();
    if (pattern === '*') return true;
    if (pattern === lowered) return true;
    if (pattern.startsWith('*.') && lowered.endsWith('.' + pattern.slice(2))) return true;
  }
  return false;
}

export function parseAllowlistEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse `host:port` from a CONNECT line. Returns null on malformed. */
export function parseConnectTarget(line: string): { host: string; port: number } | null {
  // CONNECT host:port HTTP/1.1
  const m = line.match(/^CONNECT\s+([^:\s]+):(\d{1,5})\s+HTTP\/1\.[01]\b/i);
  if (!m) return null;
  const host = m[1]!;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}
