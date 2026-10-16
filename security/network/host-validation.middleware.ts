/**
 * `HostValidationMiddleware` — Security spec §16.3.
 *
 * **Threat:** Host-header injection / cache poisoning / password-reset-link poisoning.
 * `security.allowedHosts` empty ⇒ deliberate opt-out (the check is skipped entirely).
 *
 * Matching (SPEC-ERRATA E-S13 — the spec says `allowed.includes(host)`, which is
 * case-sensitive and breaks on `Host: API.example.com` and on an explicit default port):
 *  - hostnames compare case-insensitively;
 *  - an entry WITHOUT a port matches that hostname on any port; an entry WITH a port
 *    (`api.example.com:8443`) matches only that exact host:port;
 *  - `*.example.com` matches any subdomain (one or more labels) but NOT the apex;
 *  - the request's Host must itself be a plain host[:port] — anything with whitespace,
 *    slashes, `@`, control characters, … is rejected before it is compared.
 * Rejection is `400 { code: 'INVALID_HOST', message }`.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { sendSecurityError } from './security-response';

const REQUEST_HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/;

interface HostEntry {
  readonly host: string;
  readonly port: string | undefined;
  readonly wildcard: boolean;
}

function parseEntry(raw: string): HostEntry {
  const lowered = raw.trim().toLowerCase();
  const wildcard = lowered.startsWith('*.');
  const match = REQUEST_HOST_RE.exec(wildcard ? lowered.slice(2) : lowered);
  if (!match) throw new Error(`Invalid security.allowedHosts entry "${raw}"`);
  return { host: match[1] as string, port: match[2], wildcard };
}

/** Pure; exported for unit tests. Returns `undefined` for an empty list (= no restriction). */
export function compileHostMatcher(entries: readonly string[]): ((hostHeader: unknown) => boolean) | undefined {
  if (entries.length === 0) return undefined;
  const compiled = entries.map(parseEntry);
  return (hostHeader: unknown): boolean => {
    if (typeof hostHeader !== 'string') return false;
    const match = REQUEST_HOST_RE.exec(hostHeader.toLowerCase());
    if (!match) return false;
    const host = match[1] as string;
    const port = match[2];
    return compiled.some((e) => {
      if (e.port !== undefined && e.port !== port) return false;
      return e.wildcard ? host.endsWith(`.${e.host}`) : host === e.host;
    });
  };
}

@Injectable()
export class HostValidationMiddleware implements NestMiddleware {
  private readonly matches: ((hostHeader: unknown) => boolean) | undefined;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    this.matches = compileHostMatcher(config.get<string[]>('security.allowedHosts'));
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.matches || this.matches(req.headers.host)) {
      next();
      return;
    }
    sendSecurityError(res, 400, 'INVALID_HOST', 'Invalid Host header');
  }
}
