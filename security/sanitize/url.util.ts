/**
 * URL sanitisation and SSRF defence — Security spec §13.
 *
 * `sanitizeUrl` — for URLs that will be RENDERED or STORED (a profile link, a redirect
 * target): returns the normalised absolute URL, or `null`. Scheme allowlist (default
 * http/https), no embedded credentials (`https://trusted.com@evil.com` phishing form),
 * control characters rejected outright (WHATWG parsing silently strips TAB/LF/CR inside a
 * URL, which is how `java\tscript:` slips past naive prefix checks).
 *
 * `isSsrfSafeUrl` — for URLs the SERVER will FETCH. Resolves the hostname and requires
 * EVERY returned address to be public (see `network/ip-ranges.ts`); IP-literal hosts —
 * including the decimal/hex/octal forms WHATWG normalises (`http://2130706433/`) — are
 * checked directly, and IPv4-in-IPv6 wrappers are unwrapped or blocked.
 *
 * ⚠ DNS-rebinding TOCTOU: a hostname can resolve to a public address now and a private one
 * when the HTTP client resolves it again a moment later. This check is necessary, not
 * sufficient — the outbound client (External Services) should connect to a vetted address
 * rather than re-resolving, and egress firewall rules remain the backstop. Documented in
 * the module guide.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicIp } from '../network/ip-ranges';

const MAX_URL_LENGTH = 2048;
const DNS_TIMEOUT_MS = 3000; // architecture rule 17: every external call is bounded
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa'];

export interface SanitizeUrlOptions {
  /** Without trailing colon, case-insensitive. Default `['http', 'https']`. */
  readonly allowedProtocols?: readonly string[];
  /** Allow same-origin paths (`/x`, never `//host` or `/\host`). Default `false`. */
  readonly allowRelative?: boolean;
}

export function sanitizeUrl(input: string, options: SanitizeUrlOptions = {}): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > MAX_URL_LENGTH || CONTROL_CHARS_RE.test(trimmed)) return null;

  if (options.allowRelative && /^\/(?![/\\])/.test(trimmed)) return trimmed;

  const allowed = new Set((options.allowedProtocols ?? ['http', 'https']).map((p) => p.toLowerCase().replace(/:$/, '')));
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!allowed.has(url.protocol.slice(0, -1))) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns lookup timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Never throws; every failure mode (bad URL, DNS error, timeout) is `false` — fail closed. */
export async function isSsrfSafeUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (host === '') return false;

  if (isIP(host) !== 0) return isPublicIp(host);

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;

  try {
    const addresses = await withTimeout(lookup(host, { all: true, verbatim: true }), DNS_TIMEOUT_MS);
    return addresses.length > 0 && addresses.every((a) => isPublicIp(a.address));
  } catch {
    return false;
  }
}
