/**
 * Trusted-proxy configuration — Security spec §8.3.
 *
 * **Threat:** `req.ip` is only correct when `trust proxy` matches the real proxy topology;
 * without it a client can spoof `X-Forwarded-For` and pick its own rate-limit / IP-policy
 * bucket. Default is `false` (untrusted until explicitly configured).
 *
 * This is the ONE file (with `ip/`) allowed to mention the forwarded-for header in
 * source (§24 source-scanning rule) — and it does not even read it: it only hands the
 * setting to the platform.
 *
 * Express accepts: `false`; a hop count (number); `true` (trust EVERYTHING — spoofable,
 * rejected in production by `security.cross-validation.ts`); or a comma-separated list of
 * IPs / CIDRs / the presets `loopback`, `linklocal`, `uniquelocal`.
 *
 * HTTP's `bootstrap/platform.adapter.ts` already applies this setting at boot (it must,
 * before Security's DI exists); `configureTrustProxy()` is the equivalent for a composition
 * root that wires Security directly, and both read the same key.
 */
import { isIP } from 'node:net';
import type { ConfigService } from '../../config';

export type TrustProxySetting = boolean | number | string;

/** The slice of an Express application this needs — keeps this file free of an `express` type import. */
export interface TrustProxyTarget {
  set(setting: string, value: unknown): unknown;
}

export interface NestAppLike {
  getHttpAdapter(): { getInstance(): TrustProxyTarget };
}

const PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** True iff `entry` is a preset, an IP, or an IP/prefix CIDR. */
export function isValidTrustProxyEntry(entry: string): boolean {
  const e = entry.trim();
  if (PRESETS.has(e)) return true;
  const [addr, prefix, ...rest] = e.split('/');
  if (rest.length > 0 || addr === undefined) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** An IP address or CIDR (no presets) — the shape of an allowlist/blocklist entry. */
export function isValidIpOrCidr(entry: string): boolean {
  return !PRESETS.has(entry.trim()) && isValidTrustProxyEntry(entry);
}

export function configureTrustProxy(app: NestAppLike, config: ConfigService): void {
  const trustProxy = config.get<TrustProxySetting>('security.trustProxy');
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
}
