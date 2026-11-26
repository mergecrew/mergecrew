import { describe, expect, it } from 'vitest';
import { classifyIp, parseIPv4Loose, parseIPv6, type IpKind } from '../src/ip.js';

describe('classifyIp', () => {
  const cases: Array<[string, IpKind, string | null]> = [
    // --- IPv4 public
    ['1.1.1.1', 'public', '1.1.1.1'],
    ['8.8.8.8', 'public', '8.8.8.8'],
    ['93.184.216.34', 'public', '93.184.216.34'],
    ['172.15.255.255', 'public', '172.15.255.255'],
    ['172.32.0.1', 'public', '172.32.0.1'],
    ['100.63.255.255', 'public', '100.63.255.255'],
    ['100.128.0.1', 'public', '100.128.0.1'],
    // --- IPv4 private / loopback / cgnat
    ['10.0.0.1', 'private', '10.0.0.1'],
    ['172.16.0.1', 'private', '172.16.0.1'],
    ['172.31.255.255', 'private', '172.31.255.255'],
    ['192.168.1.1', 'private', '192.168.1.1'],
    ['127.0.0.1', 'loopback', '127.0.0.1'],
    ['127.255.255.254', 'loopback', '127.255.255.254'],
    ['100.64.0.1', 'cgnat', '100.64.0.1'],
    ['100.127.255.255', 'cgnat', '100.127.255.255'],
    // --- IPv4 always-blocked
    ['0.0.0.0', 'unspecified', '0.0.0.0'],
    ['0.1.2.3', 'unspecified', '0.1.2.3'],
    ['169.254.169.254', 'metadata', '169.254.169.254'],
    ['169.254.170.2', 'metadata', '169.254.170.2'],
    ['100.100.100.200', 'metadata', '100.100.100.200'],
    ['169.254.1.1', 'link-local', '169.254.1.1'],
    ['224.0.0.1', 'multicast', '224.0.0.1'],
    ['239.255.255.250', 'multicast', '239.255.255.250'],
    ['255.255.255.255', 'broadcast', '255.255.255.255'],
    ['240.0.0.1', 'reserved', '240.0.0.1'],
    ['192.0.0.1', 'reserved', '192.0.0.1'],
    ['198.18.0.1', 'reserved', '198.18.0.1'],
    ['192.0.2.1', 'documentation', '192.0.2.1'],
    ['203.0.113.9', 'documentation', '203.0.113.9'],
    // --- IPv4 encoding tricks
    ['2130706433', 'loopback', '127.0.0.1'], // decimal
    ['0x7f000001', 'loopback', '127.0.0.1'], // hex
    ['0x7f.1', 'loopback', '127.0.0.1'], // hex + short form
    ['0177.0.0.1', 'loopback', '127.0.0.1'], // octal
    ['0177.1', 'loopback', '127.0.0.1'],
    ['127.1', 'loopback', '127.0.0.1'],
    ['127.0.1', 'loopback', '127.0.0.1'],
    ['017700000001', 'loopback', '127.0.0.1'], // octal 32-bit
    ['2852039166', 'metadata', '169.254.169.254'], // decimal metadata
    ['0xa9.0xfe.0xa9.0xfe', 'metadata', '169.254.169.254'],
    ['0251.0376.0251.0376', 'metadata', '169.254.169.254'],
    ['0', 'unspecified', '0.0.0.0'],
    ['10.1', 'private', '10.0.0.1'],
    ['127.0.0.1.', 'loopback', '127.0.0.1'], // trailing dot
    // --- IPv6
    ['::', 'unspecified', '::'],
    ['::1', 'loopback', '::1'],
    ['[::1]', 'loopback', '::1'],
    ['0:0:0:0:0:0:0:1', 'loopback', '::1'],
    ['fe80::1', 'link-local', 'fe80::1'],
    ['fe80::1%eth0', 'link-local', 'fe80::1'],
    ['febf::1', 'link-local', 'febf::1'],
    ['fec0::1', 'private', 'fec0::1'],
    ['fc00::1', 'unique-local', 'fc00::1'],
    ['fd12:3456::1', 'unique-local', 'fd12:3456::1'],
    ['fd00:ec2::254', 'metadata', 'fd00:ec2::254'],
    ['ff02::1', 'multicast', 'ff02::1'],
    ['2001:db8::1', 'documentation', '2001:db8::1'],
    ['2001:4860:4860::8888', 'public', '2001:4860:4860::8888'],
    ['2606:4700:4700::1111', 'public', '2606:4700:4700::1111'],
    ['100::1', 'reserved', '100::1'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved', null], // teredo
    ['4000::1', 'reserved', '4000::1'], // unallocated
    // --- IPv4-mapped / embedded IPv6
    ['::ffff:127.0.0.1', 'loopback', null],
    ['[::ffff:127.0.0.1]', 'loopback', null],
    ['::ffff:7f00:1', 'loopback', null],
    ['::ffff:169.254.169.254', 'metadata', null],
    ['::ffff:a9fe:a9fe', 'metadata', null],
    ['::ffff:10.0.0.1', 'private', null],
    ['::ffff:0:10.0.0.1', 'private', null], // SIIT
    ['::ffff:8.8.8.8', 'public', null],
    ['::127.0.0.1', 'reserved', null], // IPv4-compatible (deprecated)
    ['64:ff9b::127.0.0.1', 'loopback', null], // NAT64
    ['64:ff9b::8.8.8.8', 'public', null],
    ['64:ff9b:1::1', 'private', null],
    ['2002:7f00:1::1', 'loopback', null], // 6to4 embedding 127.0.0.1
    ['2002:a9fe:a9fe::1', 'metadata', null],
    ['2002:808:808::1', 'public', null],
    // --- not IPs
    ['example.com', 'invalid', null],
    ['localhost', 'invalid', null],
    ['1e100.net', 'invalid', null],
    ['256.1.1.1', 'invalid', null],
    ['1.2.3.4.5', 'invalid', null],
    ['0x', 'invalid', null],
    ['08.1.1.1', 'invalid', null], // 08 is not valid octal
    ['', 'invalid', null],
    [':::', 'invalid', null],
    ['1::2::3', 'invalid', null],
    ['12345::1', 'invalid', null],
    ['::ffff:999.0.0.1', 'invalid', null],
  ];

  it.each(cases)('%s → %s', (input, kind, normalized) => {
    const c = classifyIp(input);
    expect(c.kind).toBe(kind);
    if (normalized !== null) expect(c.normalized).toBe(normalized);
  });
});

describe('parsers', () => {
  it('parseIPv4Loose rejects out-of-range parts', () => {
    expect(parseIPv4Loose('4294967296')).toBeNull();
    expect(parseIPv4Loose('1.16777216')).toBeNull();
    expect(parseIPv4Loose('1.2.65536')).toBeNull();
    expect(parseIPv4Loose('4294967295')).toEqual([255, 255, 255, 255]);
  });

  it('parseIPv6 expands :: and embedded IPv4', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toHaveLength(16);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7::8')).toBeNull();
  });
});
