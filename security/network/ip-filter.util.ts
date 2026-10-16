/**
 * IP allowlist / blocklist — Security spec §16.2. CIDR (or single-address) entries,
 * IPv4 and IPv6. Usage: admin endpoints, internal-only routes — and, when
 * `security.ipPolicy.*` is non-empty, the global policy (see `SecurityModule.configure`).
 *
 * Semantics: a BLOCKLIST match always denies (deny wins); a non-empty ALLOWLIST requires a
 * match; an empty/absent list imposes nothing. An address that cannot be determined
 * (`'unknown'`) is denied — a policy that cannot evaluate its input fails closed.
 *
 * Policies are compiled once (per policy object, WeakMap-cached) into `net.BlockList`s, and
 * a malformed entry throws at compile time — i.e. at boot for the configured policy, at
 * `createIpFilterMiddleware()` call time for a per-route one, never on a request.
 */
import { BlockList, isIP } from 'node:net';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getClientIp, normalizeIp } from '../ip/ip.utils';
import { sendSecurityError } from './security-response';

export interface IpPolicy {
  readonly allowlist?: readonly string[];
  readonly blocklist?: readonly string[];
}

interface CompiledIpPolicy {
  readonly allow: BlockList | undefined;
  readonly block: BlockList | undefined;
}

const compiled = new WeakMap<IpPolicy, CompiledIpPolicy>();

function compileList(entries: readonly string[] | undefined, label: string): BlockList | undefined {
  if (!entries || entries.length === 0) return undefined;
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const [address, prefix, ...extra] = entry.split('/');
    const family = address === undefined ? 0 : isIP(address);
    if (extra.length > 0 || family === 0 || address === undefined) {
      throw new Error(`Invalid ${label} entry "${raw}": expected an IP address or CIDR (e.g. 10.0.0.0/8, 2001:db8::/32)`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
    } else {
      const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
      if (!(bits >= 0 && bits <= (family === 4 ? 32 : 128))) {
        throw new Error(`Invalid ${label} entry "${raw}": prefix length out of range`);
      }
      list.addSubnet(address, bits, type);
    }
  }
  return list;
}

/** Validates + caches a policy. Throws on a malformed entry. */
export function compileIpPolicy(policy: IpPolicy): CompiledIpPolicy {
  const cached = compiled.get(policy);
  if (cached) return cached;
  const next: CompiledIpPolicy = Object.freeze({
    allow: compileList(policy.allowlist, 'allowlist'),
    block: compileList(policy.blocklist, 'blocklist'),
  });
  compiled.set(policy, next);
  return next;
}

export function isIpAllowed(ip: string, policy: IpPolicy): boolean {
  if (typeof ip !== 'string') return false;
  const normalized = normalizeIp(ip);
  const family = isIP(normalized);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const { allow, block } = compileIpPolicy(policy);
  if (block?.check(normalized, type)) return false;
  if (allow) return allow.check(normalized, type);
  return true;
}

export function hasIpPolicy(policy: IpPolicy): boolean {
  return (policy.allowlist?.length ?? 0) > 0 || (policy.blocklist?.length ?? 0) > 0;
}

export function createIpFilterMiddleware(policy: IpPolicy): NestMiddleware {
  compileIpPolicy(policy); // fail at construction, not on the first request
  return {
    use(req: Request, res: Response, next: NextFunction): void {
      if (isIpAllowed(getClientIp(req), policy)) {
        next();
        return;
      }
      sendSecurityError(res, 403, 'IP_NOT_ALLOWED', 'Access from this IP address is not allowed');
    },
  };
}
