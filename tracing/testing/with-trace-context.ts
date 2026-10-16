/**
 * withTraceContext() — the Tracing equivalent of Config's staticSource (§3.4
 * of the Config spec). Wraps fn in a synthetic, fully-populated context for
 * tests that need to assert something was correctly correlated, without
 * needing a real OTel SDK or exporter. Exported from tracing/index.ts itself
 * (§13), not relegated to a separate, non-public testing entrypoint.
 *
 * Pair with OpenTelemetry's own InMemorySpanExporter (from
 * @opentelemetry/sdk-trace-base) for any test that needs to assert a real
 * span — and its links — were correctly created, rather than standing up a
 * real trace backend.
 */
import { randomUUID } from 'node:crypto';
import { runWithContext } from '../tracing.context';
import type { TraceContext } from '../tracing.port';

export function withTraceContext<T>(
  overrides: Partial<TraceContext>,
  fn: () => T,
): T {
  const ctx: TraceContext = Object.freeze({
    correlationId: overrides.correlationId ?? `test-${randomUUID()}`,
    traceId: overrides.traceId,
    spanId: overrides.spanId,
    causationId: overrides.causationId,
  });
  return runWithContext(ctx, fn);
}
