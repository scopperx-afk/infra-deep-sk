/**
 * `RequestContextMiddleware` — HTTP spec §9, §3 step 2. Second in the chain,
 * right after `TraceBindingMiddleware` (§3's own ordering rationale: nothing
 * here needs Tracing's context, but binding `RequestContext` before Logger's
 * own middleware keeps every later step's context fully established before
 * business logic runs).
 *
 * `locale`: an explicit `?locale=` query override wins outright (highest
 * priority — a deliberate, per-call consumer choice); otherwise parsed from
 * `Accept-Language` per RFC 7231 (comma-separated `tag;q=value` entries,
 * highest `q` wins, `*` ignored as "no specific preference," a malformed
 * `q` value degrades to being ignored rather than throwing).
 *
 * `clientVersion`: read from `http.clientVersionHeader` (default
 * `x-client-version`) — spec §9 calls this "a project-defined header, e.g.
 * X-Client-Version" and does not fix the name; this implementation makes the
 * header name itself configurable via Config, the same pattern
 * `http.correlationHeader` already uses, rather than hardcoding the example
 * literally (see SPEC-ERRATA.md E-H2).
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { runWithRequestContext } from '../context/request-context.store';
import type { RequestContext } from '../context/request-context.port';
import type { HttpConfig } from '../config/http.schema';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** RFC 7231 §5.3.1 quality-value parsing — never throws on malformed input. */
export function parseAcceptLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const candidates: Array<{ tag: string; q: number }> = [];
  for (const raw of header.split(',')) {
    const [tagPart, ...params] = raw.trim().split(';');
    const tag = tagPart.trim();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim() === 'q') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) q = parsed;
      }
    }
    candidates.push({ tag, q });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.q - a.q);
  return candidates[0].tag;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly clientVersionHeader: string;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    this.clientVersionHeader = config.getNamespace<HttpConfig>('http').clientVersionHeader;
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const ctx: RequestContext = {};
    const locale = firstQueryValue(req.query?.locale) ?? parseAcceptLanguage(firstHeaderValue(req.headers['accept-language']));
    if (locale !== undefined) ctx.locale = locale;
    const clientVersion = firstHeaderValue(req.headers[this.clientVersionHeader]);
    if (clientVersion !== undefined) ctx.clientVersion = clientVersion;
    runWithRequestContext(ctx, () => next());
  }
}
