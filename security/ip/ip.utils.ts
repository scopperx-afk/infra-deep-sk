/**
 * IP primitives — Security spec §16.1.
 *
 * `getClientIp()` is the ONLY sanctioned path to a client IP in the codebase
 * (anti-pattern #12). It deliberately does NOT parse `X-Forwarded-For` itself: Express
 * already does that — correctly — according to the `trust proxy` setting (§8.3), and
 * exposes the result as `req.ip`. Re-implementing that parse here would be a second,
 * driftable copy of the single most spoofing-prone header on the internet.
 *
 * No `isIpMismatch()` (v5 removed it — session-IP binding is Authentication's, §16.1).
 */
import { isIP } from 'node:net';

export interface IpCarrier {
  readonly ip?: string | undefined;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

/** Expands any VALID IPv6 text (compressed, mixed dotted-quad tail, zone id) to eight 16-bit groups. */
function parseIpv6(ip: string): number[] | undefined {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    s = `${s.slice(0, lastColon + 1)}${(((v4[0] as number) << 8) | (v4[1] as number)).toString(16)}:${(((v4[2] as number) << 8) | (v4[3] as number)).toString(16)}`;
  }
  let groups: string[];
  const dbl = s.indexOf('::');
  if (dbl !== -1) {
    if (s.indexOf('::', dbl + 1) !== -1) return undefined;
    const head = s.slice(0, dbl) === '' ? [] : s.slice(0, dbl).split(':');
    const rest = s.slice(dbl + 2) === '' ? [] : s.slice(dbl + 2).split(':');
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return undefined;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some((n) => Number.isNaN(n)) ? undefined : nums;
}

/**
 * Canonical form used for every comparison in this module: trimmed; IPv6 lower-cased; an
 * IPv4-MAPPED IPv6 address in ANY spelling (`::ffff:10.0.0.1`, `::ffff:a00:1`,
 * `0:0:0:0:0:ffff:a00:1`) unwrapped to its plain IPv4 (`10.0.0.1`), so a mapped address can
 * never dodge an IPv4 rule.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (isIP(trimmed) !== 6) return trimmed;
  const g = parseIpv6(trimmed);
  if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const hi = g[6] as number;
    const lo = g[7] as number;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return trimmed.toLowerCase();
}

/**
 * The client's IP as determined by the platform's `trust proxy` configuration, normalised
 * (IPv4-mapped IPv6 → plain IPv4). Returns `'unknown'` — never `undefined`, never a raw
 * header value — when nothing trustworthy is available, so a caller keying a bucket or a
 * log field on it cannot be handed an attacker-chosen string.
 */
export function getClientIp(req: IpCarrier): string {
  const candidate = req.ip ?? req.socket?.remoteAddress;
  if (typeof candidate !== 'string') return 'unknown';
  const ip = normalizeIp(candidate);
  return isIP(ip) === 0 ? 'unknown' : ip;
}
