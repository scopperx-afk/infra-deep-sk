/**
 * Request timeout — HTTP spec §7.2. `http.timeout.requestMs` bounds an
 * individual request's ENTIRE remaining lifetime — including CORS/body-
 * parsing/compression, not just Nest's own controller pipeline — so this is
 * a plain FACTORY-PRODUCED Express `RequestHandler`, applied via `app.use()`
 * in `bootstrap/platform.adapter.ts`, NOT a `NestMiddleware` class wired
 * through `configure()`.
 *
 * Verified empirically while building this module (see the container's own
 * session — reproducible via a minimal Nest app): an `app.use()` call made
 * right after `NestFactory.create()` returns runs BEFORE every
 * `configure()`-registered `NestMiddleware`, including `TraceBindingMiddleware`
 * (§8, step 1). Only a plain, pre-Nest-pipeline Express middleware can
 * correctly wrap the WHOLE thing — a `NestMiddleware` class, however early in
 * `configure()`, would already be too late to bound CORS/body-parsing time.
 *
 * ── Node has no true cancellation — what this can and cannot guarantee ───────
 * If the timeout fires while a handler is still awaiting I/O (a slow DB query,
 * a hung upstream call), this middleware sends the timeout response and
 * destroys the connection; it CANNOT force the still-running handler code to
 * stop executing (no JS runtime can, for already-scheduled synchronous or
 * microtask work) — the same limitation every Express timeout middleware has
 * (`connect-timeout` included). Sets `req.timedOut = true` — the same
 * documented convention `connect-timeout` uses — so cooperating downstream
 * code CAN check it before doing further expensive work or writing a second
 * response; this middleware ALSO destroys the socket so a late, uncooperative
 * write fails at the OS/socket level rather than corrupting an already-sent
 * response.
 *
 * Status **503** (not 408, not 504): 408 is defined by RFC 9110 as the
 * SERVER waiting on the CLIENT to finish SENDING a request — the opposite
 * direction from what happens here; 504 is conventionally a reverse proxy's
 * own upstream-timeout signal. 503 — "temporarily unable to handle this,
 * try again" — is both the closest accurate meaning and, deliberately, the
 * same status Errors' own `ServiceUnavailableError` uses (Errors spec §6),
 * for one consistent "retryable, transient" signal across this codebase.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface TimedOutRequest extends Request {
  timedOut?: boolean;
}

export function createTimeoutMiddleware(timeoutMs: number): RequestHandler {
  return (req: TimedOutRequest, res: Response, next: NextFunction) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled || res.headersSent) return; // belt-and-suspenders: never double-respond ourselves
      settled = true;
      req.timedOut = true;
      res.status(503).json({ error: 'Request Timeout', message: `Request exceeded ${timeoutMs}ms` });
      req.destroy();
      res.socket?.destroy();
    }, timeoutMs);
    timer.unref?.(); // never keeps the process alive on its own (matters for graceful shutdown, §12)

    const clear = (): void => {
      settled = true;
      clearTimeout(timer);
    };
    res.on('finish', clear); // the real handler responded first — normal case
    res.on('close', clear); // client disconnected early — nothing left to time out

    next();
  };
}
