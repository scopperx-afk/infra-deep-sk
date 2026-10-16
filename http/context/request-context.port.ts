/**
 * `RequestContext` — HTTP spec §9. A third, narrowly-scoped, HTTP-owned store —
 * never folded into Tracing's `TraceContext` (fixed four fields, Tracing spec
 * §3/§15.3) and never into Logger's `LogContext` either: `locale`/
 * `clientVersion` are application-level request context, not tracing or
 * logging concerns, even though both happen to be request-scoped (Anti-Pattern #7).
 *
 * `userId` is deliberately absent (§9, Anti-Pattern's own note): identity
 * belongs to Security, a Layer-1 sibling — HTTP does not pre-empt that
 * ownership by inventing its own copy of "the current user."
 */
export interface RequestContext {
  locale?: string;
  clientVersion?: string;
}
