/**
 * DI tokens — Tracing spec §5.
 *
 * Plain Symbol() only, never Symbol.for(), matching Config's own token rule
 * (config.tokens.ts). There is no TRACING_REGISTRY and no forFeature() —
 * unlike Config, no other module registers a schema with Tracing.
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
export const TRACING_SERVICE = Symbol('TRACING_SERVICE');

// ── Internal — NOT exported from index.ts (§5) ────────────────────────────────
export const TRACING_OTEL_SDK = Symbol('TRACING_OTEL_SDK');
export const TRACING_OPTIONS = Symbol('TRACING_OPTIONS');
