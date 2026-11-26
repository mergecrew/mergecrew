/**
 * Egress allowlist (#10, #188, #560). Per-project list of host patterns
 * that agent skills are allowed to reach over the network.
 *
 * # Where this allowlist is enforced
 *
 * Two layers, with different guarantees:
 *
 * 1. **Node-level (this file).** `skillFetch()` / `recordAndAssertEgress()`
 *    are used by HTTP-bound skills (`web.fetch_url`, `web.smoke_check`,
 *    `web.lighthouse`, `web.screenshot_url`, and any custom HTTPS skill
 *    declared in `mergecrew.yaml`). This layer blocks the LLM from naming
 *    a non-allowlisted or internal host inside a skill arg. It does NOT
 *    see traffic that an agent's build script initiates from within the
 *    sandbox — `curl` / `wget` / `npm install` don't go through Node's
 *    network APIs, so this file can't observe them. With the V0 process
 *    driver, that's the gap documented in #188.
 *
 * 2. **Network namespace (driver, Phase 4 — #573 / #574 / #575).**
 *    When the runner runs with `RUNNER_SANDBOX=docker`, the sandbox
 *    container lives in its own network namespace. Phase 4 layers
 *    nftables default-deny + a per-run DNS resolver on that namespace,
 *    so every outbound packet — whether from Node, a shell skill, or
 *    anything in between — is checked against the same allowlist.
 *    That's the hard control the project setting promises.
 *
 * # Semantics (used by both layers)
 *
 *  - `undefined` / `null` allowlist = no *hostname* restriction
 *    (back-compat default for projects that haven't opted in). Private,
 *    loopback, link-local, CGNAT, metadata and other non-public
 *    destinations are still refused — see below.
 *  - `[]` empty list = block all outbound HTTP.
 *  - `['*']` = explicit allow-all (public destinations only).
 *  - Otherwise: `host` matches if it equals a pattern, OR the pattern
 *    starts with `*.` and `host` is a strict subdomain of the suffix
 *    (e.g. `*.example.com` matches `api.example.com` but NOT `example.com`).
 *  - Non-public destinations are NEVER reachable by default, whatever the
 *    allowlist says. The check runs on IP literals in any spelling
 *    (decimal, octal, hex, IPv4-mapped IPv6…) and, for hostnames, on
 *    every address the name resolves to. The request itself then
 *    connects to the vetted address (`@mergecrew/net` `safeFetch`) so a
 *    rebinding DNS answer can't redirect it, and each redirect hop is
 *    re-checked against both the allowlist and the address rules.
 *  - Operator escape hatch: with `MERGECREW_ALLOW_PRIVATE_EGRESS=1` (or a
 *    host listed in `MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS`), a private
 *    destination is reachable only when the project allowlist names its
 *    host explicitly (not via `*`). Metadata and link-local addresses
 *    stay blocked regardless.
 */

import {
  classifyIp,
  isLoopbackHostname,
  isMetadataHostname,
  normalizeHostname,
  privateEgressAllowedByEnv,
  privateEgressHostsFromEnv,
  resolveAndVet,
  safeFetch,
  UnsafeEgressError,
  type EgressOptions,
  type Resolver,
  type SafeFetchOptions,
} from '@mergecrew/net';

export class EgressBlocked extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(host: string, message?: string) {
    super(message ?? `egress to ${host} is not allowed`);
    this.name = 'EgressBlocked';
  }
}

function matchesPattern(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    // Match strict subdomains only — `*.example.com` does NOT match
    // `example.com`. Operators add the bare host as a separate entry
    // when they want both.
    if (host.endsWith('.' + suffix)) return true;
  }
  return false;
}

/** True when the allowlist names `host` explicitly (exact or `*.suffix`, never bare `*`). */
function explicitlyListed(host: string, allowlist: string[] | null | undefined): boolean {
  if (!allowlist) return false;
  return allowlist.some((p) => p !== '*' && matchesPattern(host, p.toLowerCase()));
}

function privateOptInFor(host: string, allowlist: string[] | null | undefined): boolean {
  if (!explicitlyListed(host, allowlist)) return false;
  return privateEgressAllowedByEnv() || privateEgressHostsFromEnv().includes(host);
}

/**
 * Hostname-level classification, no DNS. Returns the block reason for an
 * IP literal or a well-known local/metadata name, or null if the name
 * has to be resolved to decide.
 */
function literalBlockReason(
  host: string,
  allowlist: string[] | null | undefined,
): 'loopback' | 'private' | null {
  const lit = classifyIp(host);
  if (lit.kind !== 'invalid') {
    if (lit.kind === 'public') return null;
    const optable =
      lit.kind === 'private' || lit.kind === 'loopback' || lit.kind === 'cgnat' || lit.kind === 'unique-local';
    if (optable && privateOptInFor(host, allowlist)) return null;
    return lit.kind === 'loopback' ? 'loopback' : 'private';
  }
  if (isMetadataHostname(host)) return 'private';
  if (isLoopbackHostname(host)) return privateOptInFor(host, allowlist) ? null : 'loopback';
  return null;
}

/**
 * Synchronous, DNS-free check: allowlist match plus refusal of non-public
 * IP literals and local/metadata names, regardless of the allowlist.
 * This cannot see what a hostname resolves to — HTTP skills must use
 * `skillFetch` (or at least `recordAndAssertEgress`) for the full check.
 */
export function isHostAllowed(host: string, allowlist: string[] | null | undefined): boolean {
  const h = normalizeHostname(host);
  if (literalBlockReason(h, allowlist)) return false;
  if (allowlist === undefined || allowlist === null) return true;
  if (allowlist.length === 0) return false;
  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    if (matchesPattern(h, pattern.toLowerCase())) return true;
  }
  return false;
}

/** Throws `EgressBlocked` on disallowed URLs. DNS-free; see `isHostAllowed`. */
export function assertEgressAllowed(url: string, allowlist: string[] | null | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlocked(url, 'cannot parse URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlocked(parsed.protocol, 'only http(s) URLs are allowed');
  }
  const host = normalizeHostname(parsed.hostname);
  if (!isHostAllowed(host, allowlist)) {
    throw new EgressBlocked(host);
  }
}

/**
 * Context consumed by the recording/fetch helpers. `SkillExecutionContext`
 * satisfies it structurally.
 */
export interface EgressRecordCtx {
  egressAllowlist?: string[] | null;
  emit?: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  /** DNS resolver override (tests). Defaults to the system resolver. */
  egressResolver?: Resolver;
}

/** `@mergecrew/net` egress options derived from the project allowlist. */
export function skillEgressOptions(ctx: EgressRecordCtx): EgressOptions {
  const allowlist = ctx.egressAllowlist;
  return {
    allowPrivate: (h) => privateEgressAllowedByEnv() && explicitlyListed(h, allowlist),
    allowPrivateHosts: privateEgressHostsFromEnv().filter((h) => explicitlyListed(h, allowlist)),
    ...(ctx.egressResolver ? { resolver: ctx.egressResolver } : {}),
  };
}

/**
 * Recording check used by HTTP skills (#576): allowlist match, then DNS
 * resolution with every resolved address vetted. Throws `EgressBlocked`
 * on disallowed URLs and fires an `egress.checked` event on `ctx.emit`
 * so the runner can persist it to the `egress_events` table that drives
 * the run-detail "Network" section.
 *
 * Keep the recording side-effect best-effort: a missing `ctx.emit` (test
 * contexts, or future skill callers that don't care about audit) just
 * skips the event. Enforcement still happens.
 */
export async function recordAndAssertEgress(
  url: string,
  ctx: EgressRecordCtx,
  origin: string,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    await safeEmit(ctx, {
      source: 'skill',
      origin,
      host: url.slice(0, 200),
      decision: 'blocked',
      reason: 'parse_error',
    });
    throw new EgressBlocked(url, 'cannot parse URL');
  }
  const host = normalizeHostname(parsed.hostname);
  const literal = literalBlockReason(host, ctx.egressAllowlist);
  if (literal || !isHostAllowed(host, ctx.egressAllowlist)) {
    await safeEmit(ctx, {
      source: 'skill',
      origin,
      host,
      decision: 'blocked',
      reason: literal ?? 'unlisted',
    });
    throw new EgressBlocked(host);
  }

  // The name is allowed; now check what it actually resolves to.
  try {
    await resolveAndVet(parsed, skillEgressOptions(ctx));
  } catch (err) {
    let reason = 'other';
    if (err instanceof UnsafeEgressError && err.reason !== 'resolution') {
      reason = err.reason === 'loopback' ? 'loopback' : 'private';
    }
    await safeEmit(ctx, { source: 'skill', origin, host, decision: 'blocked', reason });
    throw new EgressBlocked(host);
  }

  await safeEmit(ctx, {
    source: 'skill',
    origin,
    host,
    decision: 'allowed',
    reason: ctx.egressAllowlist === null || ctx.egressAllowlist === undefined ? 'unrestricted' : 'allowlist',
  });
}

/**
 * Fetch for HTTP skills. Every hop (the initial URL and each redirect)
 * goes through `recordAndAssertEgress`, and the connection is pinned to
 * the vetted address. Throws `EgressBlocked` when a hop is refused;
 * transport failures surface as `SafeFetchError` with generic messages.
 */
export async function skillFetch(
  url: string,
  init: RequestInit,
  ctx: EgressRecordCtx,
  origin: string,
  opts: Omit<SafeFetchOptions, keyof EgressOptions | 'validateUrl'> = {},
): Promise<Response> {
  try {
    return await safeFetch(url, init, {
      ...opts,
      ...skillEgressOptions(ctx),
      validateUrl: (u) => recordAndAssertEgress(u.href, ctx, origin),
    });
  } catch (err) {
    if (err instanceof UnsafeEgressError) throw new EgressBlocked(hostOf(url));
    throw err;
  }
}

function hostOf(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return 'invalid-url';
  }
}

async function safeEmit(ctx: EgressRecordCtx, payload: Record<string, unknown>): Promise<void> {
  if (!ctx.emit) return;
  try {
    await ctx.emit('egress.checked', payload);
  } catch {
    // Audit logging must never break the skill.
  }
}
