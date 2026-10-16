/**
 * Owns deriveContext()/runAsBoundary()/injectContext()/startSpan() — §8.0's
 * branching rule, span creation/linking/ending, and the
 * correlationId/causationId resolution logic (§4.1, §8, §8.6). Calls into
 * tracing.context.ts for the actual ALS read/bind, never duplicates it.
 *
 * Tracing never throws its own errors to callers (§4.1, §10) — every function
 * here either returns a safe value or degrades silently. The one thing this
 * does NOT cover: a caller-supplied `fn` that itself throws propagates that
 * exception completely unchanged to fn's own caller, after the context/span
 * this file created is still correctly restored/ended first.
 */
import { randomUUID } from 'node:crypto';
import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { getTraceContext, runWithContext } from './tracing.context';
import type { TraceCarrier, TraceContext } from './tracing.port';

const TRACER_NAME = 'infrastructure/tracing';

// ─────────────────────────────────────────────────────────────────────────────
// §8.6 — input sanitization for every externally-sourced identifier
// ─────────────────────────────────────────────────────────────────────────────
const ID_PATTERN = /^[A-Za-z0-9\-_.]{1,128}$/;

function sanitizeId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value)
    ? value
    : undefined;
}

/** correlationId: a value that fails sanitization is treated exactly like a
 *  missing one — a fresh id is generated instead, silently (§8.6). */
function resolveCorrelationId(candidate: unknown): string {
  return sanitizeId(candidate) ?? randomUUID();
}

/**
 * causationId: when currentMessageId is supplied, it unconditionally
 * overwrites carrier.causationId — sanitized, and on failure set to
 * `undefined`, never replaced with a generated value, because unlike
 * correlationId there is no concept of "a fresh causationId" (§8.6). When
 * currentMessageId is omitted entirely (the HTTP case, §8.1; a cron tick,
 * §8.4), falls through to carrier.causationId unchanged.
 */
function resolveCausationId(
  currentMessageId: string | undefined,
  carrierCausationId: unknown,
): string | undefined {
  if (currentMessageId !== undefined) return sanitizeId(currentMessageId);
  return typeof carrierCausationId === 'string'
    ? carrierCausationId
    : undefined;
}

function freeze(ctx: TraceContext): TraceContext {
  return Object.freeze({ ...ctx });
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as unknown as PromiseLike<unknown>).then === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.0 — the one branching rule every boundary shares
// ─────────────────────────────────────────────────────────────────────────────

/** True only when a live, valid OTel span is already active right now —
 *  checked via OTel's own API, per §8.0, never Tracing's own ALS state. */
function hasActiveSpan(): Span | undefined {
  const active = trace.getActiveSpan();
  return active && trace.isSpanContextValid(active.spanContext())
    ? active
    : undefined;
}

/** §8.0 case 2: extracts a SpanContext to link to from carrier.traceparent,
 *  via OTel's own registered propagator (never a hand-rolled parser) — a
 *  malformed or unparseable value degrades to `undefined` (case 3), never
 *  throws. */
function extractLinkedSpanContext(
  carrier: Partial<TraceCarrier> | undefined,
): SpanContext | undefined {
  if (!carrier?.traceparent) return undefined;
  try {
    const headers: Record<string, string> = {
      traceparent: carrier.traceparent,
    };
    if (carrier.tracestate) headers.tracestate = carrier.tracestate;
    const extracted = propagation.extract(ROOT_CONTEXT, headers);
    const spanContext = trace.getSpanContext(extracted);
    return spanContext && trace.isSpanContextValid(spanContext)
      ? spanContext
      : undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — §4.1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID-resolution only — never creates or activates a span (§4.1). Used
 * directly, on its own, only at the HTTP boundary (§8.1), where
 * instrumentation-http has already created and activated the span this reads.
 */
export function deriveContext(
  carrier: Partial<TraceCarrier> = {},
  currentMessageId?: string,
): TraceContext {
  try {
    const correlationId = resolveCorrelationId(carrier.correlationId);
    const causationId = resolveCausationId(
      currentMessageId,
      carrier.causationId,
    );
    const active = hasActiveSpan();
    if (active) {
      const spanContext = active.spanContext();
      return freeze({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        correlationId,
        causationId,
      });
    }
    return freeze({ correlationId, causationId });
  } catch {
    // Never throws on Tracing's own account, even given a garbage carrier (§4.1).
    return freeze({ correlationId: randomUUID() });
  }
}

/**
 * The atomic, safe-to-call-anywhere operation for an async-messaging boundary
 * (§4.1, §8.2, §8.3, §8.5). Branches on §8.0's active-span check itself.
 */
export function runAsBoundary<T>(
  spanName: string,
  carrier: Partial<TraceCarrier> | undefined,
  currentMessageId: string | undefined,
  fn: () => T,
): T {
  const active = hasActiveSpan();

  if (active) {
    // Case 1 — reuse the already-active span as-is; spanName is ignored.
    // Functionally deriveContext() + runWithContext() for this one case,
    // which is exactly what makes runAsBoundary() safe to call even when the
    // caller can't be sure in advance whether a span is already active —
    // this is the direct fix for the webhook double-span risk (§8.5).
    const ctx = deriveContext(carrier, currentMessageId);
    return runWithContext(ctx, fn);
  }

  // Case 2/3 — no live span: create and activate a real root span, linked to
  // carrier.traceparent when it parses (case 2), unlinked otherwise (case 3).
  const correlationId = resolveCorrelationId(carrier?.correlationId);
  const causationId = resolveCausationId(
    currentMessageId,
    carrier?.causationId,
  );
  const linkedSpanContext = extractLinkedSpanContext(carrier);
  const links = linkedSpanContext ? [{ context: linkedSpanContext }] : [];

  const tracer = trace.getTracer(TRACER_NAME);
  // Passing ROOT_CONTEXT as the parent context (rather than relying on no
  // context currently being active) is what structurally guarantees this is
  // always a new root span, never accidentally parented to something already
  // sitting in ambient context (§8.0's case 2/3 requirement).
  const span = tracer.startSpan(
    spanName,
    { kind: SpanKind.CONSUMER, links },
    ROOT_CONTEXT,
  );
  const spanContext = span.spanContext();
  const ctx = freeze({
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    correlationId,
    causationId,
  });

  const activatedOtelContext = trace.setSpan(otelContext.active(), span);
  return otelContext.with(activatedOtelContext, () =>
    runWithContext(ctx, () => runAndEndSpan(span, fn)),
  );
}

/** Shared "end the span whether fn resolves, throws, or returns a promise
 *  that later settles" logic, used by both runAsBoundary() and startSpan() —
 *  a thrown/rejected error from fn is recorded on the span and re-thrown/
 *  re-rejected unchanged, never swallowed (§4.1, §10). */
function runAndEndSpan<T>(span: Span, fn: () => T): T {
  let result: T;
  try {
    result = fn();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error)?.message,
    });
    span.end();
    throw err;
  }
  if (isPromiseLike(result)) {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        span.end();
        return value;
      },
      (err: unknown) => {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        span.end();
        throw err;
      },
    ) as unknown as T;
  }
  span.end();
  return result;
}

/**
 * Reads the CURRENT context and produces a carrier for a job's or event's
 * envelope metadata (§4.1, §8). correlationId is always present on the
 * result — if called outside any bound context, a fresh root context is
 * derived first rather than returning something half-empty.
 */
export function injectContext(): TraceCarrier {
  const ctx = getTraceContext() ?? deriveContext();
  const carrier: TraceCarrier = { correlationId: ctx.correlationId };
  if (ctx.causationId !== undefined) carrier.causationId = ctx.causationId;

  const active = hasActiveSpan();
  if (active) {
    const headers: Record<string, string> = {};
    propagation.inject(trace.setSpan(otelContext.active(), active), headers);
    if (headers.traceparent) carrier.traceparent = headers.traceparent;
    if (headers.tracestate) carrier.tracestate = headers.tracestate;
  }
  return Object.freeze(carrier);
}

/**
 * Manual span creation for work with no auto-instrumentation coverage (§4.1).
 * A thin wrapper over the OTel Tracer API: startActiveSpan() already gives us
 * exactly the "child if a span is active in ambient context, new root
 * otherwise" behavior the spec asks for, with no extra branching needed here.
 */
export function startSpan<T>(name: string, fn: () => T): T {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, (span: Span) => runAndEndSpan(span, fn));
}
