/**
 * Tracing spec §13 — unit + contract tests.
 *
 * This file wires a real OTel TracerProvider with an InMemorySpanExporter
 * (§13's own recommended pairing for withTraceContext()) plus a real
 * AsyncHooksContextManager, so OTel's own active-span tracking behaves
 * exactly as it would under the real NodeSDK — without a live exporter
 * endpoint. It does NOT go through tracing.bootstrap.ts (which is a
 * side-effecting, import-once script meant for main.ts, §15.1) — instead it
 * exercises tracing.context.ts / tracing.propagation.ts directly, the same
 * functions tracing.bootstrap.ts's SDK sits underneath.
 *
 * Coverage here is a representative subset of §13's full list — the specific
 * regression tests §13/§17 call out by name (case-1 webhook double-span
 * prevention, case-2/3 span nesting, sanitization fallback asymmetry, thrown-
 * error propagation, spansStarted/export-counter independence) — not every
 * bullet. See README.md's "Testing" section for which §13 items still need an
 * integration-level harness (a running NodeSDK, a real .env-leakage
 * filesystem fixture, an ESLint boundary lint run) beyond what a single unit
 * test file can exercise.
 */
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { context as otelContext, propagation, trace } from '@opentelemetry/api';
import {
  ExportResultCode,
  W3CTraceContextPropagator,
  type ExportResult,
} from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { getTraceContext, runWithContext } from './tracing.context';
import {
  deriveContext,
  injectContext,
  runAsBoundary,
  startSpan,
} from './tracing.propagation';
import {
  CountingSpanExporter,
  PassThroughSpanProcessor,
  TracingObservation,
} from './tracing.health';
import { withTraceContext } from './testing/with-trace-context';

let memoryExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  // Bug fix (found while installing this module): without this, extractLinkedSpanContext()'s
  // propagation.extract() and injectContext()'s propagation.inject() both run against the
  // API's default NOOP propagator — traceparent is never parsed on the way in nor written on
  // the way out, so "linked when traceparent parses (case 2)" and "carries traceparent when a
  // real span is active" fail even though tracing.propagation.ts's own logic is correct. In
  // production this registration happens inside tracing.bootstrap.ts's NodeSDK constructor
  // (`textMapPropagator: new W3CTraceContextPropagator()`), which this file deliberately does
  // not run (see this file's own header comment) — so the unit-test harness must register the
  // same propagator itself, exactly as it already stands up its own TracerProvider.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  memoryExporter.reset();
});

const CTRL_CHAR_ID = 'bad\nid';
const OVERLONG_ID = 'a'.repeat(129);

describe('deriveContext() (§4.1, §8.0, §8.6)', () => {
  it('leaves traceId/spanId undefined and always returns a real correlationId when no span is active', () => {
    const ctx = deriveContext();
    expect(ctx.traceId).toBeUndefined();
    expect(ctx.spanId).toBeUndefined();
    expect(ctx.correlationId).toEqual(expect.any(String));
    expect(ctx.correlationId.length).toBeGreaterThan(0);
  });

  it("reuses an already-active span's traceId/spanId as-is (§8.0 case 1), never re-parsing carrier.traceparent", () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('inbound-http', (span) => {
      const ctx = deriveContext({
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      });
      const sc = span.spanContext();
      expect(ctx.traceId).toBe(sc.traceId);
      expect(ctx.spanId).toBe(sc.spanId);
      span.end();
    });
  });

  it('reuses carrier.correlationId when it passes sanitization', () => {
    const ctx = deriveContext({ correlationId: 'abc-123.def_456' });
    expect(ctx.correlationId).toBe('abc-123.def_456');
  });

  it.each([
    ['control characters', CTRL_CHAR_ID],
    ['over-length', OVERLONG_ID],
    ['empty string', ''],
  ])(
    'silently generates a fresh correlationId when the carrier value is invalid (%s) — never throws',
    (_label, bad) => {
      const ctx = deriveContext({ correlationId: bad });
      expect(ctx.correlationId).not.toBe(bad);
      expect(ctx.correlationId.length).toBeGreaterThan(0);
    },
  );

  it('always takes causationId from currentMessageId when supplied, overwriting carrier.causationId', () => {
    const ctx = deriveContext({ causationId: 'stale-hop' }, 'job-42');
    expect(ctx.causationId).toBe('job-42');
  });

  it('falls back to undefined (never a generated value) when currentMessageId fails sanitization', () => {
    const ctx = deriveContext({ causationId: 'stale-hop' }, CTRL_CHAR_ID);
    expect(ctx.causationId).toBeUndefined();
  });

  it('falls through to carrier.causationId unchanged when currentMessageId is omitted (§8.1 HTTP case)', () => {
    const ctx = deriveContext({ causationId: undefined });
    expect(ctx.causationId).toBeUndefined();
  });

  it('never throws given a garbage carrier', () => {
    const garbage: any = {
      correlationId: 12345,
      causationId: {},
      traceparent: 42,
      tracestate: null,
    };
    expect(() => deriveContext(garbage, {} as unknown as string)).not.toThrow();
  });
});

describe('runAsBoundary() — case 1: an active span already present (§4.1, §8.0, §8.5)', () => {
  it('creates no new span and ignores spanName — the direct webhook double-span regression test', async () => {
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('webhook-server-span', async (span) => {
      await runAsBoundary('webhook.stripe', undefined, 'evt_123', () => {
        expect(getTraceContext()?.traceId).toBe(span.spanContext().traceId);
        expect(getTraceContext()?.causationId).toBe('evt_123');
      });
      span.end();
    });
    await provider.forceFlush();
    expect(memoryExporter.getFinishedSpans()).toHaveLength(1); // exactly one span, not two
  });
});

describe('runAsBoundary() — case 2/3: no active span (§4.1, §8.0, §8.2, §8.3)', () => {
  it('creates and activates a real root span, linked when traceparent parses (case 2)', async () => {
    const producerTraceparent =
      '00-11111111111111111111111111111111-2222222222222222-01';
    runAsBoundary(
      'queue.consume.send-confirmation',
      { correlationId: 'c-1', traceparent: producerTraceparent },
      'job-A',
      () => {
        const ctx = getTraceContext();
        expect(ctx?.correlationId).toBe('c-1');
        expect(ctx?.causationId).toBe('job-A');
        expect(ctx?.traceId).toBeDefined();
        expect(ctx?.traceId).not.toBe('11111111111111111111111111111111'); // NEW root, not a continuation
      },
    );
    await provider.forceFlush();
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].links).toHaveLength(1);
    expect(spans[0].links[0].context.traceId).toBe(
      '11111111111111111111111111111111',
    );
  });

  it('degrades to an unlinked root when traceparent is malformed (case 3) — never throws', async () => {
    runAsBoundary(
      'queue.consume.x',
      { correlationId: 'c-2', traceparent: 'not-a-real-traceparent' },
      'job-B',
      () => {
        expect(getTraceContext()?.traceId).toBeDefined();
      },
    );
    await provider.forceFlush();
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].links).toHaveLength(0);
  });

  it('a sub-startSpan() call inside fn appears as a genuine child of the boundary span, not a disconnected root', async () => {
    runAsBoundary('event.consume.order.confirmed', undefined, 'evt-1', () => {
      startSpan('db.query', () => {
        /* noop */
      });
    });
    await provider.forceFlush();
    const spans = memoryExporter.getFinishedSpans();
    const boundarySpan = spans.find(
      (s) => s.name === 'event.consume.order.confirmed',
    )!;
    const childSpan = spans.find((s) => s.name === 'db.query')!;
    expect(childSpan.parentSpanId).toBe(boundarySpan.spanContext().spanId);
  });

  it('ends the span on both success and thrown error, and never swallows the thrown error', async () => {
    expect(() =>
      runAsBoundary('queue.consume.will-throw', undefined, 'job-C', () => {
        throw new Error('handler failed');
      }),
    ).toThrow('handler failed');
    await provider.forceFlush();
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('omitting currentMessageId entirely (the cron case, §8.4) leaves causationId undefined, no special-casing needed', () => {
    runAsBoundary('cron.nightly-reconciliation', undefined, undefined, () => {
      expect(getTraceContext()?.causationId).toBeUndefined();
    });
  });
});

describe('runWithContext() (§4.1, §13)', () => {
  it('nested calls: the inner context is visible only inside its own callback; the outer is restored after', () => {
    const A = { correlationId: 'A' };
    const B = { correlationId: 'B' };
    runWithContext(A, () => {
      runWithContext(B, () => {
        expect(getTraceContext()?.correlationId).toBe('B');
      });
      expect(getTraceContext()?.correlationId).toBe('A');
    });
  });

  it('concurrent runs via Promise.all each observe only their own context', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => i);
    await Promise.all(
      runs.map((i) =>
        runWithContext({ correlationId: `c-${i}` }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          expect(getTraceContext()?.correlationId).toBe(`c-${i}`);
        }),
      ),
    );
  });

  it('restores the outer context after fn throws', () => {
    runWithContext({ correlationId: 'outer' }, () => {
      expect(() =>
        runWithContext({ correlationId: 'inner' }, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(getTraceContext()?.correlationId).toBe('outer');
    });
  });

  it('getTraceContext() returns undefined outside any bound context', () => {
    expect(getTraceContext()).toBeUndefined();
  });
});

describe('injectContext() (§4.1, §8)', () => {
  it('outside any bound context still returns a carrier with a real correlationId and no traceparent', () => {
    const carrier = injectContext();
    expect(carrier.correlationId).toEqual(expect.any(String));
    expect(carrier.traceparent).toBeUndefined();
  });

  it('carries traceparent when a real span is active', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('outbound', (span) => {
      const carrier = injectContext();
      expect(carrier.traceparent).toContain(span.spanContext().traceId);
      span.end();
    });
  });
});

describe('startSpan() (§4.1, §13)', () => {
  it('starts a root span with no active context', async () => {
    startSpan('utility.task', () => undefined);
    await provider.forceFlush();
    expect(memoryExporter.getFinishedSpans()[0].parentSpanId).toBeUndefined();
  });

  it("never throws on its own account even though fn's own exception still propagates", () => {
    expect(() =>
      startSpan('utility.will-throw', () => {
        throw new Error('inner failure');
      }),
    ).toThrow('inner failure');
  });
});

describe('withTraceContext() test helper (§13)', () => {
  it('binds a synthetic context for the duration of fn', () => {
    withTraceContext({ correlationId: 'fixed-id', traceId: 't-1' }, () => {
      expect(getTraceContext()).toMatchObject({
        correlationId: 'fixed-id',
        traceId: 't-1',
      });
    });
  });
});

describe('TracingObservation — health/metrics (§10, §11, §13)', () => {
  it('distinguishes deliberate disablement from misconfiguration', () => {
    const disabled = new TracingObservation();
    disabled.markDisabled();
    expect(disabled.getHealth().message).toBe(
      'disabled (OTEL_SDK_DISABLED=true)',
    );

    const misconfigured = new TracingObservation();
    misconfigured.markMisconfigured('OTEL_SERVICE_NAME not set');
    expect(misconfigured.getHealth().message).toBe(
      'misconfigured: OTEL_SERVICE_NAME not set',
    );
    expect(misconfigured.getHealth().message).not.toBe(
      disabled.getHealth().message,
    );
  });

  it('spansStartedTotal increments independently of, and ahead of, export outcome', async () => {
    const observation = new TracingObservation();
    const processor = new PassThroughSpanProcessor(observation);
    // Simulate onStart() firing for two spans before either has exported.

    processor.onStart({} as any, {} as any);

    processor.onStart({} as any, {} as any);
    expect(observation.getMetricsSnapshot().spansStartedTotal).toBe(2);
    expect(observation.getMetricsSnapshot().spansExportedTotal).toBe(0);

    const failingDelegate: SpanExporter = {
      export(_spans: ReadableSpan[], cb: (result: ExportResult) => void) {
        cb({
          code: ExportResultCode.FAILED,
          error: new Error('endpoint unreachable'),
        });
      },
      shutdown: () => Promise.resolve(),
    };
    const counting = new CountingSpanExporter(failingDelegate, observation);

    counting.export([{} as any], () => undefined);

    const snapshot = observation.getMetricsSnapshot();
    expect(snapshot.spansStartedTotal).toBe(2); // unaffected by the export failure
    expect(snapshot.spansDroppedTotal).toBe(1);
    expect(snapshot.exportFailuresTotal).toBe(1);
    expect(snapshot.lastExportError).toBe('endpoint unreachable');
    expect(observation.getHealth().exporterHealthy).toBe(false);
  });

  it('a successful export increments spansExportedTotal, not spansDroppedTotal', () => {
    const observation = new TracingObservation();
    const succeedingDelegate: SpanExporter = {
      export(spans: ReadableSpan[], cb: (result: ExportResult) => void) {
        cb({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    const counting = new CountingSpanExporter(succeedingDelegate, observation);

    counting.export([{} as any, {} as any], () => undefined);
    const snapshot = observation.getMetricsSnapshot();
    expect(snapshot.spansExportedTotal).toBe(2);
    expect(snapshot.spansDroppedTotal).toBe(0);
  });
});
