/**
 * Early-rejection response for Security's own MIDDLEWARE (host / smuggling / IP / HTTPS).
 *
 * A middleware that rejects a request answers directly — it is not a handler, so there is
 * no thrown `HttpException` for Errors' `GlobalExceptionFilter` to catch at this stage.
 * The body matches Errors' wire contract (`{ code, message }`, spec §5 — `traceId` is
 * omitted: Security deliberately does not depend on Tracing, and the correlation id is
 * already on HTTP's own response header by the time this runs).
 *
 * (SPEC-ERRATA E-S5 — §16.3's sketch returned `{ code }` alone; every other error body in
 * the platform carries `message` too, so a client has ONE shape to parse.)
 */
import type { Response } from 'express';

export function sendSecurityError(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ code, message });
}
