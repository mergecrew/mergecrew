import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyIp, type IpKind } from './ip.js';

/**
 * Address kinds that are never reachable, even with the operator opt-in:
 * instance metadata, link-local, unspecified, multicast/broadcast and
 * reserved/documentation space have no legitimate use as a tenant- or
 * LLM-supplied destination.
 */
const ALWAYS_BLOCKED: ReadonlySet<IpKind> = new Set<IpKind>([
  'metadata',
  'link-local',
  'unspecified',
  'multicast',
  'broadcast',
  'documentation',
  'reserved',
  'invalid',
]);

/**
 * Address kinds reachable only when the operator explicitly opts in
 * (self-hosters with a local Ollama, an in-cluster webhook receiver…).
 */
const PRIVATE_KINDS: ReadonlySet<IpKind> = new Set<IpKind>([
  'private',
  'loopback',
  'cgnat',
  'unique-local',
]);

/**
 * Hostnames that are blocked by name before any resolution happens. These
 * either always point at the local host or at a metadata service on the
 * major clouds, and some resolvers answer them from /etc/hosts.
 */
const LOOPBACK_HOSTNAMES = [/^localhost$/, /\.localhost$/];
const METADATA_HOSTNAMES = [
  /^metadata$/,
  /^metadata\.google\.internal$/,
  /^instance-data(\.ec2\.internal)?$/,
  /^metadata\.azure\.internal$/,
];

export interface EgressOptions {
  /**
   * Allow destinations in private/loopback/CGNAT/ULA space. A function
   * form lets callers decide per hostname (e.g. only for hosts a project
   * explicitly allowlisted). Metadata and link-local stay blocked
   * regardless. Defaults to the `MERGECREW_ALLOW_PRIVATE_EGRESS` env
   * resolution in {@link privateEgressAllowedByEnv}.
   */
  allowPrivate?: boolean | ((hostname: string) => boolean);
  /**
   * Exact hostnames (or IP literals) that may resolve to private space even
   * when `allowPrivate` is false. Populated from
   * `MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS` by default — e.g. `ollama` for a
   * hosted deployment's shared in-cluster model server.
   */
  allowPrivateHosts?: readonly string[];
  /** DNS resolver; injectable for tests. Defaults to `dns.lookup(all)`. */
  resolver?: Resolver;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Reason codes on {@link UnsafeEgressError}. Safe to log; not meant for end users. */
export type EgressBlockReason =
  | 'protocol'
  | 'credentials'
  | 'hostname'
  | 'resolution'
  | IpKind;

/**
 * Thrown when a destination is refused. The `message` is deliberately
 * generic so it can be surfaced to end users without becoming a
 * reachability oracle; `reason` carries the detail for server-side logs.
 */
export class UnsafeEgressError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(
    readonly reason: EgressBlockReason,
    message = 'destination is not allowed or could not be reached',
  ) {
    super(message);
    this.name = 'UnsafeEgressError';
  }
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}
function falsy(v: string | undefined): boolean {
  return v !== undefined && /^(0|false|no|off)$/i.test(v.trim());
}

/**
 * Operator opt-in for private destinations.
 *
 *  - `MERGECREW_ALLOW_PRIVATE_EGRESS=1` → allowed.
 *  - `MERGECREW_ALLOW_PRIVATE_EGRESS=0` → denied.
 *  - unset → allowed only when `NODE_ENV=development` (local `pnpm dev` /
 *    compose stacks with an `ollama` sidecar). Production, test and an
 *    unset NODE_ENV all deny.
 */
export function privateEgressAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MERGECREW_ALLOW_PRIVATE_EGRESS;
  if (truthy(v)) return true;
  if (falsy(v)) return false;
  return env.NODE_ENV === 'development';
}

export function privateEgressHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MERGECREW_PRIVATE_EGRESS_ALLOW_HOSTS ?? '')
    .split(',')
    .map((s) => normalizeHostname(s))
    .filter(Boolean);
}

/** Lower-case, strip brackets and a single trailing dot. */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** Names that always refer to a metadata service. Never reachable. */
export function isMetadataHostname(host: string): boolean {
  const h = normalizeHostname(host);
  return METADATA_HOSTNAMES.some((re) => re.test(h));
}

/** Names that always refer to the local host. Reachable only with the private opt-in. */
export function isLoopbackHostname(host: string): boolean {
  const h = normalizeHostname(host);
  return LOOPBACK_HOSTNAMES.some((re) => re.test(h));
}

function privateAllowedFor(hostname: string, opts: EgressOptions): boolean {
  const hosts = opts.allowPrivateHosts ?? privateEgressHostsFromEnv();
  if (hosts.includes(hostname)) return true;
  const ap = opts.allowPrivate;
  if (typeof ap === 'function') return ap(hostname);
  if (typeof ap === 'boolean') return ap;
  return privateEgressAllowedByEnv();
}

/**
 * Decide whether a single resolved address may be contacted for
 * `hostname`. Returns null when allowed, or the blocking reason.
 */
export function checkAddress(
  address: string,
  hostname: string,
  opts: EgressOptions = {},
): EgressBlockReason | null {
  const { kind } = classifyIp(address);
  if (kind === 'public') return null;
  if (ALWAYS_BLOCKED.has(kind)) return kind;
  if (PRIVATE_KINDS.has(kind) && privateAllowedFor(normalizeHostname(hostname), opts)) return null;
  return kind;
}

/**
 * Validate a URL's shape (http/https, no embedded credentials, not a
 * blocked hostname) and resolve its host, rejecting it if *any* resolved
 * address is disallowed. Returns the address to pin the connection to.
 */
export async function resolveAndVet(
  url: URL,
  opts: EgressOptions = {},
): Promise<ResolvedAddress> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeEgressError('protocol');
  }
  if (url.username || url.password) {
    throw new UnsafeEgressError('credentials');
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new UnsafeEgressError('hostname');

  const literal = classifyIp(hostname);
  if (literal.kind !== 'invalid') {
    const reason = checkAddress(hostname, hostname, opts);
    if (reason) throw new UnsafeEgressError(reason);
    return { address: literal.normalized!, family: literal.version! };
  }

  if (isMetadataHostname(hostname)) throw new UnsafeEgressError('metadata');
  if (isLoopbackHostname(hostname) && !privateAllowedFor(hostname, opts)) {
    throw new UnsafeEgressError('loopback');
  }

  let addrs: ResolvedAddress[];
  try {
    addrs = await (opts.resolver ?? systemResolver)(hostname);
  } catch {
    throw new UnsafeEgressError('resolution');
  }
  if (addrs.length === 0) throw new UnsafeEgressError('resolution');
  for (const a of addrs) {
    const reason = checkAddress(a.address, hostname, opts);
    if (reason) throw new UnsafeEgressError(reason);
  }
  return addrs[0]!;
}

/**
 * Convenience: parse + vet a URL string without making a request. Use at
 * registration time (webhook URL, Ollama endpoint) to fail fast; the
 * request path must still go through `safeFetch`, which re-resolves and
 * pins.
 */
export async function assertSafeUrl(url: string, opts: EgressOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeEgressError('hostname');
  }
  await resolveAndVet(parsed, opts);
  return parsed;
}
