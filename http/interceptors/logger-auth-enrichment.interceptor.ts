/**
 * `LoggerAuthEnrichmentInterceptor` — HTTP spec §3 step 6a, §13. Backfills
 * `LogContext.userId` once a Guard has resolved identity — Guards run AFTER
 * middleware, unconditionally, in Nest's own architecture, so `req.user`
 * simply does not exist yet at step 3 (`LoggerMiddleware`) if Security
 * implements identity resolution as a Guard (the common, idiomatic pattern
 * for JWT-based auth in NestJS) rather than as middleware. This interceptor
 * is the coordinated fix §13 describes: it runs in the BEFORE-handler
 * interceptor phase (step 6), strictly after Guards (step 5) have run,
 * regardless of which mechanism Security used.
 *
 * Calls Logger's own exported `enrichLogContext()` (Logger spec §8) — never
 * reaches into Logger's ALS store directly, and never invents a second
 * identity concept of its own.
 *
 * `req.user`'s exact shape is Security's own `AuthPrincipal` port, not yet
 * built in this project — read defensively (`id` or the JWT-standard `sub`
 * claim, whichever is present) rather than assuming one exact field name;
 * see SPEC-ERRATA.md E-H3.
 */
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { enrichLogContext } from '../../logger';

interface MinimalAuthPrincipal {
  id?: string | number;
  sub?: string | number;
}
interface RequestWithUser extends Request {
  user?: MinimalAuthPrincipal;
}

@Injectable()
export class LoggerAuthEnrichmentInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const rawId = req.user?.id ?? req.user?.sub;
    if (rawId !== undefined) enrichLogContext({ userId: String(rawId) });
    return next.handle();
  }
}
