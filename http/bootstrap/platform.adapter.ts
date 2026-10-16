/**
 * Platform bootstrap — HTTP spec §4-§7. One function `main.ts` calls once,
 * right after `NestFactory.create()` returns and before `app.listen()`.
 * Targets Express concretely (`@nestjs/platform-express`, already this
 * project's installed adapter) — the spec itself "does not pick a platform...
 * examples are platform-agnostic" (§4), which describes how the SPEC TEXT is
 * written, not a requirement that this implementation support two platforms
 * at once; a project on Fastify swaps this one file (see SPEC-ERRATA.md E-H4).
 *
 * ── Call-order rationale, verified empirically against this exact NestJS/
 * Express combination while building this module ─────────────────────────────
 * `app.enableCors()` mounts CORS at a special, always-effectively-first
 * position in the underlying Express router, REGARDLESS of when it's called
 * relative to other `app.use()` registrations (confirmed: an OPTIONS
 * preflight short-circuits before any later-or-earlier `app.use()` middleware
 * runs, even when `enableCors()` is the LAST setup call made). This is what
 * makes it safe to call `enableCors()` here, AFTER `ConfigService` already
 * exists, instead of needing `http.cors.*` before `NestFactory.create()` even
 * finishes constructing the DI graph that produces `ConfigService` in the
 * first place — a chicken-and-egg that would otherwise have no clean answer.
 *
 * Every subsequent `app.use()` call here (timeout, then body-parsers) DOES
 * run in plain registration order, and ALL of them run before any
 * `configure()`-registered `NestMiddleware` (`TraceBindingMiddleware` and
 * later) — also confirmed empirically. Timeout is registered FIRST among
 * these so it bounds body-parsing time too, not just the Nest-internal
 * pipeline (§7.2).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import { buildCorsOptions } from '../config/cors.config';
import type { HttpConfig } from '../config/http.schema';
import { applyBodyParsers } from '../middleware/body-parser.config';
import { createTimeoutMiddleware } from '../middleware/timeout.middleware';

/** §7.1 — gzip/brotli via the `compression` package's own standard
 *  `Accept-Encoding` negotiation (it supports brotli natively on Node ≥ 11.7,
 *  verified against the pinned version); NOT independently configurable
 *  beyond this fixed, sensible threshold (§7.1's own explicit constraint). */
const COMPRESSION_THRESHOLD_BYTES = 1024;

export function configureHttpPlatform(app: NestExpressApplication): void {
  const config = app.get<ConfigService>(CONFIG_SERVICE);
  const http = config.getNamespace<HttpConfig>('http');

  app.enableCors(buildCorsOptions(http)); // §5 — see this file's own header on call-order safety

  // §4 — `security.trustProxy` belongs to Security's own namespace, not yet built in this
  // project. Read defensively: HTTP needs this AT BOOT regardless of whether Security exists
  // yet (unlike `WebhookVerificationGuard`, which legitimately requires Security to be built
  // first — see that file's own comment) — Express's own default (`false`) applies until
  // Security registers a real value.
  app.set('trust proxy', config.has('security.trustProxy') ? config.get<string | number | boolean>('security.trustProxy') : false);

  app.use(createTimeoutMiddleware(http.timeout.requestMs)); // §7.2 — first, so it bounds everything below too
  app.use(compression({ threshold: COMPRESSION_THRESHOLD_BYTES })); // §7.1
  applyBodyParsers(app.getHttpAdapter().getInstance(), http.bodyLimit); // §6
}
