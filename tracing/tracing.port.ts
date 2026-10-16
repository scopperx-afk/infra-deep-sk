/**
 * Public contract of the Tracing module — Tracing spec §4.
 * Interfaces only; no behavior lives here (mirrors config.port.ts's own split).
 */

/**
 * The one canonical, request/job/event-scoped execution context (§3).
 * Exactly four fields, forever — see §15.3 and Anti-Pattern #1: nothing else is
 * ever added, and an existing TraceContext is never mutated in place.
 */
export interface TraceContext {
  /** undefined when OpenTelemetry is disabled or uninitialized, or when no live
   *  span was active to read from (§3, §10) — never a placeholder string. */
  readonly traceId?: string;
  readonly spanId?: string;
  /** Always populated — the one field guaranteed present in every case (§3). */
  readonly correlationId: string;
  /** undefined for a true root (an HTTP request with no upstream trigger). */
  readonly causationId?: string;
}

/**
 * What travels inside a job's or event's envelope METADATA (never its business
 * payload — see §8.2/§8.3's envelope diagrams) to carry context across a
 * process boundary.
 */
export interface TraceCarrier {
  /** Present whenever OTel is enabled and a real span was active when
   *  injectContext() was called; propagated so the consumer can establish a
   *  causal SPAN LINK back to the producer's trace (§8.0) — the consumer does
   *  NOT become a child of the producer span and does NOT continue the
   *  producer's trace. Absent when OTel is disabled (§10), or when the current
   *  TraceContext has no traceId/spanId because no real span is active. */
  traceparent?: string;
  tracestate?: string;
  correlationId: string;
  /** The producer's own causationId at the moment it injected this carrier —
   *  preserved on the wire purely for archival/debugging visibility one hop
   *  further back. Propagation logic never reads this field back on the
   *  consuming side; see deriveContext()'s/runAsBoundary()'s currentMessageId
   *  argument (§8.4). */
  causationId?: string;
}

export interface TracingService {
  /** Safe, non-throwing read of whatever context is active right now. Returns
   *  undefined outside any bound context (e.g. at raw process startup) —
   *  never throws. */
  getTraceContext(): TraceContext | undefined;

  /** Binds ctx for the duration of fn (and everything fn calls, across
   *  awaits). Nested calls behave the way Node's AsyncLocalStorage naturally
   *  behaves: the innermost bound context wins for its own callback, and the
   *  outer one is restored afterward, including when fn throws (§10, §13). */
  runWithContext<T>(ctx: TraceContext, fn: () => T): T;

  /**
   * ID-resolution only — this function NEVER creates or activates an OTel
   * span itself (see the distinction from runAsBoundary() below).
   * traceId/spanId are populated ONLY when a live OTel span is already active
   * (§8.0 case 1), read from that already-active span as-is. When no span is
   * already active (§8.0 case 2/3), traceId/spanId are left undefined — this
   * function will not fabricate IDs for a span that doesn't exist. Consumers
   * needing a REAL, exportable, correctly-linked span at a boundary with no
   * already-active span must call runAsBoundary() instead (§8.0).
   * correlationId: reused from carrier.correlationId if present and it passes
   * the sanitization rule in §8.6, otherwise generated fresh.
   * causationId: always taken from currentMessageId when that second argument
   * is supplied (itself sanitized per §8.6) — this overwrites anything in
   * carrier.causationId unconditionally. When currentMessageId is omitted
   * (the HTTP case, §8.1), falls through to carrier.causationId unchanged.
   * Never throws, on any input, including a malformed or empty carrier.
   */
  deriveContext(
    carrier?: Partial<TraceCarrier>,
    currentMessageId?: string,
  ): TraceContext;

  /**
   * The atomic, SAFE-TO-CALL-ANYWHERE operation for an async-messaging
   * boundary (queue dequeue, event consume, a webhook — §8.2, §8.3, §8.5).
   * Checks §8.0's active-span condition itself, first, and branches:
   *   - Case 1 (a live span is already active): does NOT create a new span —
   *     spanName is ignored — reuses the active span's own traceId/spanId and
   *     runs fn directly.
   *   - Case 2/3 (no live span): creates a REAL OTel span named spanName — a
   *     new root span, with a span LINK to carrier.traceparent if it parses
   *     (case 2), otherwise an unlinked root (case 3). Activates that span
   *     (via OTel's own context activation, not just Tracing's ALS) and ALSO
   *     binds the resulting TraceContext into Tracing's ALS store, both for
   *     the duration of fn; ends the span when fn settles, whether it
   *     resolves or throws — the thrown error is never swallowed.
   * correlationId/causationId resolve identically to deriveContext() in both
   * branches. currentMessageId is optional: Queue and Events always supply
   * it; a genuine boundary with no message identity of its own (a cron tick)
   * legitimately omits it, leaving causationId undefined.
   */
  runAsBoundary<T>(
    spanName: string,
    carrier: Partial<TraceCarrier> | undefined,
    currentMessageId: string | undefined,
    fn: () => T,
  ): T;

  /** Reads the CURRENT context and produces a carrier suitable for a job's or
   *  event's envelope metadata (§8). correlationId is always present on the
   *  result (never optional outbound, even if it means deriving a fresh root
   *  context first). */
  injectContext(): TraceCarrier;

  /** Manual span creation for a unit of work with no auto-instrumentation
   *  package covering it. Called outside any bound context, starts a new root
   *  span. Called inside a bound context — including inside runAsBoundary()'s
   *  fn — creates a child span of the current span. Ends the span when fn
   *  settles; a thrown error from fn propagates unchanged rather than being
   *  swallowed. A thin, minimal wrapper over the OTel Tracer API. */
  startSpan<T>(name: string, fn: () => T): T;

  /** Pull-based health read (§11) — Tracing never pushes into Health. */
  getHealth(): TracingHealth;
  /** Pull-based metrics read (§11) — Tracing never pushes into Metrics, and
   *  never uses OpenTelemetry's own Metrics API (§11's Single-Ownership note). */
  getMetricsSnapshot(): TracingMetricsSnapshot;
}

export interface TracingHealth {
  enabled: boolean;
  sdkInitialized: boolean;
  exporterHealthy: boolean;
  samplingRatio: number;
  /** Distinguishes "deliberately disabled" from "enabled but misconfigured"
   *  (§10) — e.g. "disabled (OTEL_SDK_DISABLED=true)" vs.
   *  "misconfigured: OTEL_SERVICE_NAME not set". The two must not read the
   *  same in an ops dashboard. */
  message?: string;
}

export interface TracingMetricsSnapshot {
  spansStartedTotal: number;
  spansExportedTotal: number;
  spansDroppedTotal: number;
  exportFailuresTotal: number;
  spansBuffered: number;
  lastExportError?: string;
}
