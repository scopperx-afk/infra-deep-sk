/**
 * DI tokens — Errors spec §17.
 *
 * Plain Symbol() only, matching every other module's own rule (Config, Tracing,
 * Logger). No `forRoot()`/`forFeature()` — like Logger, there's nothing
 * per-consumer to register (§17).
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
/** Injectable by a future Realtime gateway applying WsExceptionFilter per-gateway,
 *  with no direct import of ErrorsModule required (§9, §17). */
export const ERROR_MAPPER = Symbol('ERROR_MAPPER');

/**
 * §17 marks this token "Internal — not exported from index.ts", but §19 requires
 * the (not-yet-built) Metrics module to poll `getMetricsSnapshot()` off it "at its
 * own cadence" — a token that is simultaneously "never exported" and "polled by
 * another module" is self-contradictory. This implementation exports it (see
 * SPEC-ERRATA.md E-E1), the same Observation Port pattern Config/Tracing/Logger
 * each already use: the object with `getMetricsSnapshot()` on it is public.
 */
export const ERRORS_METRICS_COLLECTOR = Symbol('ERRORS_METRICS_COLLECTOR');
