/**
 * `DeprecationInterceptor` — API Infrastructure spec §8.3.
 *
 * Deviation E-A8: §8.3 puts the deprecation headers inside `EnvelopeInterceptor`. That ties a
 * header contract (RFC 8594 / 9745 / 8288) to an unrelated switch — with `api.envelope.enabled=false`
 * a deprecated endpoint would silently stop announcing its own sunset. A separate interceptor also
 * sets the headers in the BEFORE-handler phase, so an error response from a deprecated endpoint
 * carries them too (a client hitting a failing deprecated route still needs the warning).
 *
 * Headers are precomputed at decoration time (`@Deprecated()`), so the per-request work is one
 * memoised metadata lookup and a few `setHeader` calls; undecorated handlers cost one `WeakMap` hit.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import {
  DEPRECATION_KEY,
  type PreparedDeprecationHeaders,
} from '../versioning/deprecation.decorator';
import { memoisePerHandler } from './handler-plan';

interface ResponseLike {
  headersSent?: boolean;
  setHeader?: (name: string, value: string) => unknown;
  getHeader?: (name: string) => unknown;
  header?: (name: string, value: string) => unknown;
}

@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  private readonly headersFor: (ctx: ExecutionContext) => PreparedDeprecationHeaders | null;

  constructor(reflector: Reflector) {
    this.headersFor = memoisePerHandler(
      (ctx) =>
        reflector.getAllAndOverride<PreparedDeprecationHeaders | undefined>(DEPRECATION_KEY, [
          ctx.getHandler(),
          ctx.getClass(),
        ]) ?? null,
    );
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const headers = this.headersFor(ctx);
    if (headers === null) return next.handle();

    const res = ctx.switchToHttp().getResponse<ResponseLike>();
    if (res.headersSent !== true) {
      const set = (name: string, value: string): void => {
        if (typeof res.setHeader === 'function') res.setHeader(name, value);
        else res.header?.(name, value); // Fastify reply
      };
      set('Deprecation', headers.Deprecation);
      set('Sunset', headers.Sunset);
      if (headers.Link !== undefined) {
        // Never clobber a Link header another layer already set (e.g. pagination rel=next).
        const existing = typeof res.getHeader === 'function' ? res.getHeader('Link') : undefined;
        const prior = Array.isArray(existing) ? existing.join(', ') : existing;
        set('Link', typeof prior === 'string' && prior.length > 0 ? `${prior}, ${headers.Link}` : headers.Link);
      }
    }
    return next.handle();
  }
}
