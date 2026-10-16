/**
 * getHealth() / getMetricsSnapshot() state — Tracing spec §11 — plus the two
 * pull-only observation mechanisms §11 requires:
 *
 *   - a pass-through SpanProcessor that only counts onStart() (spansStartedTotal)
 *   - a decorator around the configured SpanExporter that only counts its
 *     ExportResult callback (spansExportedTotal/spansDroppedTotal/
 *     exportFailuresTotal/lastExportError)
 *
 * These are deliberately two separate mechanisms, per §11: onEnd() firing is
 * not the same event as a span actually being exported, and conflating them
 * was an earlier, corrected mistake in this spec's own history. Neither
 * mechanism ever drops, samples, or modifies a span — they only observe.
 *
 * Same pull pattern as ConfigObservation (config/observation/config.observation.ts):
 * Tracing never imports a Health or Metrics client in either direction.
 */
import type { Context, Span } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type {
  BatchSpanProcessor,
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { TracingHealth, TracingMetricsSnapshot } from './tracing.port';

type SdkState =
  'not-initialized' | 'disabled' | 'misconfigured' | 'initialized';

export class TracingObservation {
  private state: SdkState = 'not-initialized';
  private misconfiguredDetail?: string;
  private ratio = 1;
  private exporterHealthy = true;
  private lastExportError?: string;
  private spansStarted = 0;
  private spansExported = 0;
  private spansDropped = 0;
  private exportFailures = 0;
  private batchProcessor?: BatchSpanProcessor;

  // ── writers (internal — called only from tracing.bootstrap.ts and the two
  //    observation classes below) ──
  markDisabled(): void {
    this.state = 'disabled';
  }
  markMisconfigured(detail: string): void {
    this.state = 'misconfigured';
    this.misconfiguredDetail = detail;
  }
  markInitialized(): void {
    this.state = 'initialized';
  }
  setSamplingRatio(ratio: number): void {
    this.ratio = ratio;
  }
  attachBatchProcessor(processor: BatchSpanProcessor): void {
    this.batchProcessor = processor;
  }

  incSpansStarted(): void {
    this.spansStarted += 1;
  }

  recordExportResult(result: ExportResult, spanCount: number): void {
    if (result.code === ExportResultCode.SUCCESS) {
      this.spansExported += spanCount;
      this.exporterHealthy = true;
    } else {
      this.spansDropped += spanCount;
      this.exportFailures += 1;
      this.exporterHealthy = false;
      this.lastExportError = result.error?.message ?? 'export failed';
    }
  }

  // ── readers (pull side, §11) ──
  getHealth(): TracingHealth {
    const enabled = this.state !== 'disabled';
    const sdkInitialized = this.state === 'initialized';
    const message = this.resolveMessage();
    const health: TracingHealth = {
      enabled,
      sdkInitialized,
      exporterHealthy: sdkInitialized ? this.exporterHealthy : false,
      samplingRatio: this.ratio,
    };
    if (message !== undefined) health.message = message;
    return health;
  }

  private resolveMessage(): string | undefined {
    // Precedence: a deliberate disablement or a hard misconfiguration is the
    // more actionable fact and wins over a same-cycle exporter/instrumentation
    // warning, since neither of the latter can even be evaluated in that state.
    if (this.state === 'disabled') return 'disabled (OTEL_SDK_DISABLED=true)';
    if (this.state === 'misconfigured')
      return `misconfigured: ${this.misconfiguredDetail}`;
    if (this.state === 'initialized' && !this.exporterHealthy) {
      return `exporter unreachable: ${this.lastExportError ?? 'unknown error'}`;
    }
    return undefined;
  }

  getMetricsSnapshot(): TracingMetricsSnapshot {
    const snapshot: TracingMetricsSnapshot = {
      spansStartedTotal: this.spansStarted,
      spansExportedTotal: this.spansExported,
      spansDroppedTotal: this.spansDropped,
      exportFailuresTotal: this.exportFailures,
      spansBuffered: this.readBufferedCount(),
    };
    if (this.lastExportError !== undefined)
      snapshot.lastExportError = this.lastExportError;
    return snapshot;
  }

  private readBufferedCount(): number {
    if (!this.batchProcessor) return 0;
    try {
      // BatchSpanProcessor does not expose queue depth through a public API in
      // @opentelemetry/sdk-trace-base. This reaches into its internal buffer as
      // a best-effort read — version-sensitive in exactly the way §7 flags
      // Prisma's preview-feature flag name as needing a check against the
      // pinned package version, not assumed stable across releases.
      const internal = this.batchProcessor as unknown as {
        _finishedSpans?: unknown[];
      };
      return internal._finishedSpans?.length ?? 0;
    } catch {
      return 0;
    }
  }
}

/**
 * A strictly pass-through SpanProcessor (§11): increments spansStartedTotal in
 * onStart() and does nothing else — it never drops, samples, or modifies a
 * span, and export accounting happens entirely in CountingSpanExporter below,
 * never here. Registered in the SDK's spanProcessors list AFTER the real
 * batching/export processor (§11, §15.1) so it observes every span the
 * batching processor also sees, in the same order.
 */
export class PassThroughSpanProcessor implements SpanProcessor {
  constructor(private readonly observation: TracingObservation) {}

  onStart(_span: Span, _parentContext: Context): void {
    this.observation.incSpansStarted();
  }

  onEnd(_span: ReadableSpan): void {
    // Deliberately empty: onEnd() firing is not the same event as a span
    // actually being exported (§11) — that accounting lives in
    // CountingSpanExporter's export() decorator, not here.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Thin decorator around the real, configured SpanExporter (§11): intercepts
 * the ExportResult its export() method receives and increments the four
 * export-outcome counters, then forwards the original result to the caller
 * unchanged. Never alters what the real exporter sends or how the
 * BatchSpanProcessor batches it.
 */
export class CountingSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly observation: TracingObservation,
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.delegate.export(spans, (result: ExportResult) => {
      this.observation.recordExportResult(result, spans.length);
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}
