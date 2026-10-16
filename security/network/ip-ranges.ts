/**
 * Non-public address space — used by the SSRF guard (`sanitize/url.util.ts`).
 *
 * Built on `net.BlockList` (CIDR matching for IPv4 AND IPv6, no dependency). The list is
 * deliberately the full IANA special-purpose registry that is never a legitimate public
 * destination for a server-initiated request, not just RFC 1918:
 *   - loopback / link-local (incl. the 169.254.169.254 cloud-metadata endpoint) / private
 *   - CGNAT 100.64/10, benchmarking 198.18/15, documentation ranges, multicast, reserved
 *   - IPv6: loopback/unspecified, unique-local, link-local, site-local, multicast,
 *     documentation, and the IPv4-embedding transition ranges (NAT64, 6to4, Teredo) — an
 *     attacker can wrap `169.254.169.254` inside any of those.
 */
import { BlockList, isIP } from 'node:net';
import { normalizeIp } from '../ip/ip.utils';

const V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + 255.255.255.255 broadcast
];

const V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4)
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (embeds an IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const NON_PUBLIC = new BlockList();
for (const [addr, prefix] of V4) NON_PUBLIC.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of V6) NON_PUBLIC.addSubnet(addr, prefix, 'ipv6');

/**
 * true iff `ip` is a syntactically valid address OUTSIDE every non-public range.
 * An unparseable value is `false` — fail closed.
 */
export function isPublicIp(ip: string): boolean {
  const normalized = normalizeIp(ip); // ::ffff:127.0.0.1 → 127.0.0.1
  const family = isIP(normalized);
  if (family === 0) return false;
  return !NON_PUBLIC.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}
