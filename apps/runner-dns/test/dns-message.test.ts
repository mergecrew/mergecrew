import { describe, expect, it } from 'vitest';
import { buildNxdomain, parseQuery, DnsParseError } from '../src/dns-message.js';

/**
 * Build a query packet for a single A-record question. Hand-rolled to
 * avoid pulling in a DNS lib for tests — the parser and the builder
 * test each other.
 */
function buildQuery(host: string, id = 0x1234): Buffer {
  const labels = host.split('.');
  let qnameLen = 1; // trailing 0
  for (const l of labels) qnameLen += 1 + l.length;
  const buf = Buffer.alloc(12 + qnameLen + 4);
  // Header
  buf.writeUInt16BE(id, 0);
  buf.writeUInt8(0x01, 2); // RD=1
  buf.writeUInt8(0x00, 3);
  buf.writeUInt16BE(1, 4); // QDCOUNT
  // Question name
  let off = 12;
  for (const l of labels) {
    buf.writeUInt8(l.length, off);
    buf.write(l, off + 1, 'ascii');
    off += 1 + l.length;
  }
  buf.writeUInt8(0, off);
  off += 1;
  buf.writeUInt16BE(1, off); // QTYPE A
  buf.writeUInt16BE(1, off + 2); // QCLASS IN
  return buf;
}

describe('parseQuery', () => {
  it('extracts the question name and lowercases it', () => {
    const q = buildQuery('Api.Github.com');
    const parsed = parseQuery(q);
    expect(parsed.id).toBe(0x1234);
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]!.name).toBe('api.github.com');
    expect(parsed.questions[0]!.type).toBe(1);
    expect(parsed.questions[0]!.class).toBe(1);
  });

  it('throws on truncated header', () => {
    expect(() => parseQuery(Buffer.from([1, 2, 3]))).toThrow(DnsParseError);
  });

  it('throws on truncated question', () => {
    const q = buildQuery('foo.example.com');
    expect(() => parseQuery(q.slice(0, 12 + 4))).toThrow(DnsParseError);
  });
});

describe('buildNxdomain', () => {
  it('echoes the query id and sets rcode = 3', () => {
    const q = buildQuery('files.pypi.org', 0x4242);
    const r = buildNxdomain(q);
    expect(r.readUInt16BE(0)).toBe(0x4242);
    // Low byte of flags carries rcode (low nibble).
    expect(r.readUInt8(3) & 0x0f).toBe(3);
    // Counts zeroed.
    expect(r.readUInt16BE(6)).toBe(0);
    expect(r.readUInt16BE(8)).toBe(0);
    expect(r.readUInt16BE(10)).toBe(0);
  });

  it('keeps the question section bytes intact', () => {
    const q = buildQuery('api.github.com');
    const r = buildNxdomain(q);
    // The question section starts at byte 12; both buffers must agree.
    expect(r.slice(12)).toEqual(q.slice(12));
  });
});
