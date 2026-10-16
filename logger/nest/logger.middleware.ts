/**
 * LoggerMiddleware — Logger spec §31. Establishes the request-scoped
 * `LogContext` (§8) as early as possible — before any route handler, guard,
 * or interceptor runs — so every log line written anywhere during the request
 * (including inside a Guard that later rejects it) already carries
 * method/url/userAgent/ip. `userId` is deliberately NOT set here: it isn't
 * known yet (§8) — `enrichLogContext({ userId })` fills it in once a Guard has
 * resolved identity, typically from HTTP's own `LoggerAuthEnrichmentInterceptor`
 * (§8, §31; HTTP spec §13/§14).
 *
 * Generic, duck-typed request/response shapes rather than importing `express`
 * or `@types/express` as a real dependency — the HTTP module (not yet built)
 * owns the actual adapter specifics; this only needs a handful of fields any
 * Express- or Fastify-shaped request/response already has.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithLogContext } from '../context/log-context.store';

export interface MinimalRequest {
  method: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}
export interface MinimalResponse {
  on(event: 'finish' | 'close', listener: () => void): unknown;
}
export type NextFn = () => void;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: MinimalRequest, res: MinimalResponse, next: NextFn): void {
    runWithLogContext(
      {
        method: req.method,
        url: req.originalUrl ?? req.url,
        userAgent: firstHeader(req.headers['user-agent']),
        ip: req.ip ?? req.socket?.remoteAddress,
        startTime: Date.now(),
      },
      () => {
        // `next()` starts the rest of the pipeline SYNCHRONOUSLY inside this
        // `AsyncLocalStorage.run()` call — Express/Fastify both continue the
        // request via the Node event loop from here, which AsyncLocalStorage
        // correctly tracks across every subsequent await, exactly like
        // Tracing's own `runWithContext()` (Tracing spec §4.1, §13).
        next();
      },
    );
    void res; // reserved for a future response-side hook (e.g. auto-logging completion); not needed today
  }
}
