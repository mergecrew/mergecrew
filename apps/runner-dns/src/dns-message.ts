/**
 * Tiny DNS query parser + response builder (#574).
 *
 * Avoids a third-party dep so the resolver stays a ~200-line service.
 * Implements only what we need: parse the question name out of the
 * query, build NXDOMAIN responses, and forward valid queries verbatim
 * to upstream.
 *
 * Spec: RFC 1035 §4 (Messages). For background see also
 * https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.
 */

export interface DnsQuestion {
  /** Lowercased FQDN with the trailing dot stripped. */
  name: string;
  /** QTYPE (1 = A, 28 = AAAA, …). */
  type: number;
  /** QCLASS (1 = IN). */
  class: number;
}

export interface ParsedQuery {
  id: number;
  questions: DnsQuestion[];
}

export class DnsParseError extends Error {}

export function parseQuery(buf: Buffer): ParsedQuery {
  if (buf.length < 12) throw new DnsParseError('truncated DNS header');
  const id = buf.readUInt16BE(0);
  const qd = buf.readUInt16BE(4);
  let offset = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qd; i++) {
    const { name, offset: next } = readName(buf, offset);
    if (next + 4 > buf.length) throw new DnsParseError('truncated question');
    const type = buf.readUInt16BE(next);
    const cls = buf.readUInt16BE(next + 2);
    questions.push({ name, type, class: cls });
    offset = next + 4;
  }
  return { id, questions };
}

/**
 * Build an NXDOMAIN response for the given query. The response echoes
 * the request's id, flags (response bit set), and question section,
 * with rcode = 3.
 */
export function buildNxdomain(query: Buffer): Buffer {
  const out = Buffer.from(query);
  // Set flags: response (QR=1), opcode 0, recursion-available (RA=1),
  // rcode = 3 (NXDOMAIN). High byte: 1000 0001 = 0x81. Low byte:
  // 1000 0011 = 0x83.
  out.writeUInt8(0x81, 2);
  out.writeUInt8(0x83, 3);
  // AN / NS / AR counts → 0.
  out.writeUInt16BE(0, 6);
  out.writeUInt16BE(0, 8);
  out.writeUInt16BE(0, 10);
  return out;
}

function readName(buf: Buffer, offset: number): { name: string; offset: number } {
  const parts: string[] = [];
  let safety = 0;
  while (safety++ < 100) {
    if (offset >= buf.length) throw new DnsParseError('name overran buffer');
    const len = buf.readUInt8(offset);
    if (len === 0) {
      return { name: parts.join('.').toLowerCase(), offset: offset + 1 };
    }
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer. Follow once; don't advance the cursor
      // past the pointer.
      if (offset + 2 > buf.length) throw new DnsParseError('compression pointer truncated');
      const pointer = ((len & 0x3f) << 8) | buf.readUInt8(offset + 1);
      const inner = readName(buf, pointer).name;
      const head = parts.join('.');
      const joined = head ? `${head}.${inner}` : inner;
      return { name: joined.toLowerCase(), offset: offset + 2 };
    }
    if (offset + 1 + len > buf.length) throw new DnsParseError('label overran buffer');
    parts.push(buf.slice(offset + 1, offset + 1 + len).toString('ascii'));
    offset += 1 + len;
  }
  throw new DnsParseError('name decompression loop');
}
