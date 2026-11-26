/**
 * IP address parsing + classification for outbound-request vetting.
 *
 * Everything here is pure (no I/O) so it can be table-tested. The
 * parsers are deliberately lenient about the *input forms* an attacker
 * might use to smuggle an internal address past a naive string check
 * (decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f.1`, IPv4-mapped
 * IPv6 `::ffff:127.0.0.1`, zone ids, brackets) and strict about the
 * *classification*: anything that is not plainly global unicast is
 * reported as non-public.
 */

export type IpKind =
  /** Globally routable unicast. The only kind reachable by default. */
  | 'public'
  /** RFC 1918 IPv4, deprecated IPv6 site-local, local-use NAT64. */
  | 'private'
  /** 127.0.0.0/8, ::1. */
  | 'loopback'
  /** 100.64.0.0/10 shared address space (carrier-grade NAT, also used by some clouds/VPNs). */
  | 'cgnat'
  /** fc00::/7. */
  | 'unique-local'
  /** 169.254.0.0/16, fe80::/10. */
  | 'link-local'
  /** Well-known cloud instance-metadata endpoints. */
  | 'metadata'
  /** 0.0.0.0/8, ::. */
  | 'unspecified'
  /** 224.0.0.0/4, ff00::/8. */
  | 'multicast'
  /** 255.255.255.255. */
  | 'broadcast'
  /** TEST-NET / 2001:db8::/32. */
  | 'documentation'
  /** Reserved, benchmarking, transition-mechanism and unallocated space. */
  | 'reserved'
  /** Not an IP literal. */
  | 'invalid';

export interface IpClassification {
  kind: IpKind;
  version: 4 | 6 | null;
  /** Normalised textual form (dotted quad for v4, compressed for v6). */
  normalized: string | null;
}

// ---------------------------------------------------------------------------
// IPv4

/**
 * Strict dotted-quad parser (`a.b.c.d`, decimal only, no leading zeros
 * beyond a bare `0`). This is the form DNS resolvers return.
 */
export function parseIPv4Strict(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/**
 * `inet_aton`-style parser: 1–4 dot-separated parts, each decimal,
 * octal (leading `0`) or hex (`0x`), with the last part filling the
 * remaining bytes. This mirrors what `getaddrinfo` and the WHATWG URL
 * host parser accept, so `2130706433`, `0x7f000001`, `0177.1` and
 * `127.1` all map to 127.0.0.1 here as they would on the wire.
 */
export function parseIPv4Loose(input: string): [number, number, number, number] | null {
  let s = input.trim();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const parts = s.split('.');
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = p.length === 1 ? 0 : parseInt(p.slice(1), 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return null;
  const remainingBytes = 4 - nums.length;
  if (last >= 2 ** (8 * remainingBytes)) return null;
  const out = [...nums];
  for (let i = remainingBytes - 1; i >= 0; i--) {
    out.push(Math.floor(last / 2 ** (8 * i)) % 256);
  }
  return out as [number, number, number, number];
}

function inV4(b: readonly number[], net: [number, number, number, number], prefix: number): boolean {
  const ip = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const base = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

const V4_METADATA: Array<[number, number, number, number]> = [
  [169, 254, 169, 254], // AWS / GCP / Azure / OpenStack IMDS
  [169, 254, 169, 253], // AWS VPC DNS
  [169, 254, 170, 2], // ECS task metadata
  [169, 254, 170, 23], // EKS pod identity agent
  [100, 100, 100, 200], // Alibaba Cloud metadata
];

const V4_TABLE: Array<[[number, number, number, number], number, IpKind]> = [
  [[0, 0, 0, 0], 8, 'unspecified'],
  [[10, 0, 0, 0], 8, 'private'],
  [[100, 64, 0, 0], 10, 'cgnat'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link-local'],
  [[172, 16, 0, 0], 12, 'private'],
  [[192, 0, 0, 0], 24, 'reserved'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, 'reserved'],
  [[192, 168, 0, 0], 16, 'private'],
  [[198, 18, 0, 0], 15, 'reserved'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[255, 255, 255, 255], 32, 'broadcast'],
  [[240, 0, 0, 0], 4, 'reserved'],
];

export function classifyIPv4Bytes(b: readonly number[]): IpKind {
  for (const m of V4_METADATA) if (inV4(b, m, 32)) return 'metadata';
  for (const [net, prefix, kind] of V4_TABLE) if (inV4(b, net, prefix)) return kind;
  return 'public';
}

// ---------------------------------------------------------------------------
// IPv6

/** Parse an IPv6 literal (optionally bracketed, optionally with a zone id) into 16 bytes. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  let tailV4: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    tailV4 = parseIPv4Strict(tail);
    if (!tailV4) return null;
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const gs = part.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(dbl[0]!);
  const rest = dbl.length === 2 ? parseGroups(dbl[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (tailV4) {
    bytes[12] = tailV4[0]!;
    bytes[13] = tailV4[1]!;
    bytes[14] = tailV4[2]!;
    bytes[15] = tailV4[3]!;
  }
  return bytes;
}

function prefixEq(b: readonly number[], prefix: readonly number[]): boolean {
  for (let i = 0; i < prefix.length; i++) if (b[i] !== prefix[i]) return false;
  return true;
}

function allZero(b: readonly number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

const V6_METADATA: number[][] = [
  // fd00:ec2::254 — AWS IMDS over IPv6
  [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54],
  // fd00:ec2::23 — EKS pod identity agent
  [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x23],
];

export function classifyIPv6Bytes(b: readonly number[]): IpKind {
  for (const m of V6_METADATA) if (prefixEq(b, m)) return 'metadata';
  if (allZero(b, 0, 16)) return 'unspecified';
  if (allZero(b, 0, 15) && b[15] === 1) return 'loopback';
  // ::ffff:a.b.c.d — IPv4-mapped. The kernel connects to the v4 address.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyIPv4Bytes(b.slice(12));
  // ::ffff:0:a.b.c.d — SIIT translated.
  if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return classifyIPv4Bytes(b.slice(12));
  }
  // ::a.b.c.d — deprecated IPv4-compatible.
  if (allZero(b, 0, 12)) return 'reserved';
  // 64:ff9b::/96 — well-known NAT64 prefix; the gateway connects to the embedded v4.
  if (prefixEq(b, [0x00, 0x64, 0xff, 0x9b]) && allZero(b, 4, 12)) return classifyIPv4Bytes(b.slice(12));
  // 64:ff9b:1::/48 — local-use NAT64.
  if (prefixEq(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return 'private';
  // 100::/64 — discard-only.
  if (prefixEq(b, [0x01, 0x00]) && allZero(b, 2, 8)) return 'reserved';
  // 2001:db8::/32 — documentation.
  if (prefixEq(b, [0x20, 0x01, 0x0d, 0xb8])) return 'documentation';
  // 2001::/32 — Teredo; tunnels to an arbitrary embedded v4.
  if (prefixEq(b, [0x20, 0x01, 0x00, 0x00])) return 'reserved';
  // 2002::/16 — 6to4; embedded v4 in bytes 2..5.
  if (prefixEq(b, [0x20, 0x02])) {
    const inner = classifyIPv4Bytes(b.slice(2, 6));
    return inner === 'public' ? 'public' : inner;
  }
  // fc00::/7 — unique local.
  if ((b[0]! & 0xfe) === 0xfc) return 'unique-local';
  // fe80::/10 — link-local.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local';
  // fec0::/10 — deprecated site-local.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'private';
  // ff00::/8 — multicast.
  if (b[0] === 0xff) return 'multicast';
  // 2000::/3 is the only global-unicast allocation.
  if ((b[0]! & 0xe0) === 0x20) return 'public';
  return 'reserved';
}

function formatV6(b: readonly number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((b[i]! << 8) | b[i + 1]!);
  // Find the longest run of zero groups (length >= 2) for `::` compression.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

// ---------------------------------------------------------------------------
// Public entry point

/**
 * Classify an IP literal. Accepts dotted-quad and the lenient IPv4 forms
 * (`2130706433`, `0x7f.1`, `0177.0.0.1`), IPv6 with or without brackets
 * and zone ids, and IPv4-mapped/embedded IPv6. Returns `kind: 'invalid'`
 * for anything that is not an IP literal (e.g. a hostname).
 */
export function classifyIp(input: string): IpClassification {
  const s = input.trim();
  if (s.includes(':') || s.startsWith('[')) {
    const b = parseIPv6(s);
    if (!b) return { kind: 'invalid', version: null, normalized: null };
    return { kind: classifyIPv6Bytes(b), version: 6, normalized: formatV6(b) };
  }
  const v4 = parseIPv4Loose(s);
  if (!v4) return { kind: 'invalid', version: null, normalized: null };
  return { kind: classifyIPv4Bytes(v4), version: 4, normalized: v4.join('.') };
}

/** True when `input` parses as an IP literal in any accepted form. */
export function isIpLiteral(input: string): boolean {
  return classifyIp(input).kind !== 'invalid';
}
