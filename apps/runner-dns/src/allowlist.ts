/**
 * DNS allowlist matcher (#574). Mirrors the semantics of
 * `packages/skills/src/egress-policy.ts` so the Node skill layer and
 * the DNS layer agree on what's allowlisted. Kept in this app rather
 * than imported to keep `apps/runner-dns` a self-contained unit that
 * can run independently of the rest of the workspace.
 *
 * Semantics:
 *  - `*` matches anything.
 *  - Bare host (`api.github.com`) matches exactly.
 *  - `*.example.com` matches strict subdomains only — `api.example.com`
 *    matches, `example.com` does NOT. Operators add both as separate
 *    entries when they need to.
 *  - Loopback / RFC1918 addresses are never allowed once any allowlist
 *    is configured. Protects the supervisor's own host network from
 *    the sandbox (SSRF mitigation).
 */

const PRIVATE_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const lowered = host.toLowerCase().replace(/\.$/, '');
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
