/**
 * `TraceBindingMiddleware` — HTTP spec §8. HTTP's side of a contract Tracing's
 * own spec already wrote in full (Tracing spec §8.1) — repeated here only as
 * the authoritative pointer, per HTTP spec §8's own explicit instruction not
 * to re-specify it independently.
 *
 * Registered as the FIRST middleware in the chain (§3 step 1) — before
 * `RequestContextMiddleware`, before `LoggerMiddleware`, before anything else:
 * every later step wanting `correlationId`/`traceId` needs Tracing's context
 * already bound.
 *
 * `http.correlationHeader` is read ONCE, in the constructor, and cached — it
 * is NOT hot-reload-whitelisted (Config spec §10.1's fixed whitelist is
 * exactly `logging.level`/`rateLimit.*`), so re-reading it per request would
 * be pure waste on the hottest path in the whole pipeline (Anti-Pattern #9).
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { deriveContext, runWithContext } from '../../tracing';
import type { HttpConfig } from '../config/http.schema';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class TraceBindingMiddleware implements NestMiddleware {
  private readonly headerName: string;

  constructor(@Inject(CONFIG_SERVICE) config: ConfigService) {
    this.headerName = config.getNamespace<HttpConfig>('http').correlationHeader;
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = firstHeaderValue(req.headers[this.headerName]);
    const ctx = deriveContext({ correlationId: inbound }); // Tracing spec §4.2, §8.1 — sanitizes/generates as needed
    res.setHeader(this.headerName, ctx.correlationId); // §3 step 10, set here so it's present even if a later step throws
    runWithContext(ctx, () => next()); // Tracing spec §4.1
  }
}
