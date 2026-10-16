/**
 * `EnvelopeInterceptor` — API Infrastructure spec §4.3. Registered globally via `APP_INTERCEPTOR`
 * by `ApiInfrastructureModule`; lands at HTTP spec §3 step 9b.
 *
 * ── When it does NOT wrap (E-A6) ────────────────────────────────────────────────────────────
 * §4.3/§4.5 name `@SkipEnvelope()` and `@RawResponse()`. A global interceptor on a real platform
 * meets more than that, and each of the cases below would otherwise corrupt a response silently:
 *   • non-HTTP contexts (WebSocket / RPC) — the envelope is an HTTP wire contract;
 *   • `HEAD` — no body is sent;
 *   • `204` / `205` / `304` (by `@HttpCode()`, or a status the handler already set through
 *     `@Res({ passthrough: true })`) — these statuses MUST have no body; `{ data: null, … }` is a
 *     protocol violation Express would silently swallow, leaving clients and caches disagreeing;
 *   • `@Redirect()` — Nest reads `{ url, statusCode }` from the handler's return value;
 *   • `@Sse()` — wrapping each emitted event would break the event stream;
 *   • binary / stream results (`StreamableFile`, `Buffer`, Node/Web streams);
 *   • a response the handler has already written (`headersSent` / `writableEnded`).
 * An exception anywhere in the pipeline never reaches here at all — the observable stops at the
 * throw — so the envelope can never wrap an error body (§12): that is what keeps `ApiResponse.errors`
 * (partial failure, 2xx) structurally distinct from Errors' `ErrorResponseBody` (§4.2).
 *
 * Per-request cost is one `map` and one small object: config is read ONCE in the constructor
 * (`api.*` is not hot-reloadable, §11) and decorator metadata is memoised per handler.
 */
import {
  Inject,
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HTTP_CODE_METADATA, REDIRECT_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { map, type Observable } from 'rxjs';
import { getTraceContext } from '../../tracing';
import type { ApiConfig } from '../config/api.schema';
import { API_CONFIG } from '../api-infrastructure.tokens';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';
import { SKIP_ENVELOPE_KEY } from '../decorators/skip-envelope.decorator';
import type { ApiResponseMeta } from '../envelope/envelope.port';
import { wrapInEnvelope } from '../envelope/wrap-envelope';
import { nowIso } from '../util/clock';
import { extractApiVersion } from '../versioning/extract-version';
import { memoisePerHandler } from './handler-plan';

interface HttpRequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
  raw?: { url?: string };
}
interface HttpResponseLike {
  statusCode?: number;
  headersSent?: boolean;
  writableEnded?: boolean;
}

/** Statuses that MUST NOT carry a body (RFC 9110 §15.3.5, §15.3.6, §15.4.5). */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

function isStreamLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof StreamableFile || value instanceof Uint8Array) return true; // Buffer ⊂ Uint8Array
  if (typeof (value as { pipe?: unknown }).pipe === 'function') return true; // Node Readable
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  private readonly enabled: boolean;
  private readonly includeTimestamp: boolean;
  private readonly includeApiVersion: boolean;
  private readonly includeCorrelationId: boolean;
  private readonly defaultVersion: string;

  /** Static, per-handler: opted out by a decorator, or its declared status/kind cannot carry an envelope. */
  private readonly isExempt: (ctx: ExecutionContext) => boolean;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    reflector: Reflector,
  ) {
    this.enabled = config.envelope.enabled;
    this.includeTimestamp = config.envelope.includeTimestamp;
    this.includeApiVersion = config.envelope.includeApiVersion;
    this.includeCorrelationId = config.envelope.includeCorrelationId;
    this.defaultVersion = config.version;

    this.isExempt = memoisePerHandler((ctx) => {
      const targets = [ctx.getHandler(), ctx.getClass()];
      if (reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, targets)) return true;
      if (reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, targets)) return true;
      const handler = ctx.getHandler();
      if (Reflect.getMetadata(SSE_METADATA, handler) !== undefined) return true;
      if (Reflect.getMetadata(REDIRECT_METADATA, handler) !== undefined) return true;
      const declared = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      return declared !== undefined && BODYLESS_STATUSES.has(declared);
    });
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled || ctx.getType() !== 'http' || this.isExempt(ctx)) return next.handle();

    const http = ctx.switchToHttp();
    const req = http.getRequest<HttpRequestLike>();
    if (req.method === 'HEAD') return next.handle();
    const res = http.getResponse<HttpResponseLike>();

    return next.handle().pipe(
      map((result) => {
        if (
          res.headersSent === true ||
          res.writableEnded === true ||
          (res.statusCode !== undefined && BODYLESS_STATUSES.has(res.statusCode)) ||
          isStreamLike(result)
        ) {
          return result;
        }
        return wrapInEnvelope(result, this.buildMeta(req));
      }),
    );
  }

  private buildMeta(req: HttpRequestLike): ApiResponseMeta {
    const meta: ApiResponseMeta = {};
    if (this.includeTimestamp) meta.timestamp = nowIso();
    if (this.includeApiVersion) {
      meta.apiVersion =
        extractApiVersion(req.originalUrl ?? req.url ?? req.raw?.url ?? '') ?? this.defaultVersion;
    }
    if (this.includeCorrelationId) {
      // Tracing spec §4.2 — plain, no-DI read; absent (never "undefined") when there is no context.
      const correlationId = getTraceContext()?.correlationId;
      if (correlationId !== undefined) meta.correlationId = correlationId;
    }
    return meta;
  }
}
