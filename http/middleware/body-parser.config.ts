/**
 * Applies Express's own body parsers with `http.bodyLimit` — HTTP spec §6.
 * `bodyLimit` is a byte-size string ("1mb", "512kb") in the exact shape
 * `express.json()`/`express.urlencoded()` already accept natively — passed
 * straight through, never independently re-parsed by this module (§6).
 *
 * Applied via `app.use()` directly (not a `NestMiddleware` class) — same
 * empirically-verified reason `timeout.middleware.ts` gives: `app.use()`
 * calls made right after `NestFactory.create()` returns run before every
 * `configure()`-registered `NestMiddleware`, which is where this needs to sit
 * (before `TraceBindingMiddleware`, §3 step 1) so the body is already parsed
 * by the time anything downstream might need it.
 *
 * ── Raw body capture, for `WebhookVerificationGuard` (§10) ──────────────────
 * Most webhook signature schemes (Stripe, GitHub, …) sign the RAW request
 * bytes, not the parsed object — `JSON.stringify(req.body)` is not guaranteed
 * byte-identical to what the sender actually signed (key order, number
 * formatting, whitespace all differ). `express.json()`'s own `verify` hook
 * receives that raw `Buffer` before parsing discards it; this stashes it onto
 * `req.rawBody` for any later Guard that needs it. Cost is negligible: body-
 * parser already buffers the whole body internally to parse it at all, so
 * this keeps a reference to memory already allocated, not a second read.
 */
import { json, urlencoded, type Application, type Request } from 'express';
import { normalizeBodyParserErrors } from './body-parser-error.middleware';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export function applyBodyParsers(app: Application, bodyLimit: string): void {
  app.use(
    json({
      limit: bodyLimit,
      verify: (req: RequestWithRawBody, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  app.use(normalizeBodyParserErrors); // §6 — see that file's own header for why this is necessary
}
