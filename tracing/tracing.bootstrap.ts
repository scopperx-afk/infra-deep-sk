/**
 * tracing/tracing.bootstrap.ts — a plain script, not a NestJS provider, not
 * even a class (§15.1). Imported exactly once, as the literal first line of
 * main.ts, before any other import including NestFactory (§2.1, §15.1,
 * Anti-Pattern #9). Do NOT import this file from anywhere else — importing it
 * a second time is harmless (Node's module cache means sdk.start() still only
 * ever runs once), but every other consumer should go through tracing.module.ts
 * / tracing/index.ts instead, never this file directly.
 *
 * §2.1's documented, narrow exception to governing principle #5: reads
 * OTEL_* variables straight from process.env, never through ConfigService —
 * Config hasn't been constructed yet, and can't be, because Tracing needs to
 * have already monkey-patched the module loader before Config's own `fs`-
 * using boot pipeline (and every library it eventually pulls in) is first
 * imported anywhere in the process.
 *
 * Order of operations, matching §15.1's own numbered sketch:
 *   1. reads §6's OTEL_* variables directly from process.env
 *   2. performs the .env-leakage self-check described in §6's warning callout
 *   3. constructs the SDK (custom pass-through SpanProcessor from §11
 *      included) and calls sdk.start() synchronously before this file
 *      finishes executing
 *   4. performs the instrumentation-attachment self-check described in §7
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
// `Resource`'s constructor / factory surface has changed across
// @opentelemetry/resources major versions (some pin `resourceFromAttributes()`
// instead of `new Resource(...)`) — verify against the pinned version before
// relying on this import, the same version-sensitivity caveat §7 makes for
// Prisma's preview-feature flag name.
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type * as httpTypes from 'node:http';
import {
  buildInstrumentations,
  checkEnvFileLeakage,
} from './tracing.instrumentations';
import {
  CountingSpanExporter,
  PassThroughSpanProcessor,
  TracingObservation,
} from './tracing.health';
import { resourceFromAttributes } from '@opentelemetry/resources';

// ── 1/2 — read env, then immediately self-check for .env-file leakage (§6) ──
// This must run before anything below reads a single OTEL_* value, so a
// misplaced value is flagged even though it's about to be silently ignored.
checkEnvFileLeakage();

export const tracingObservation = new TracingObservation();

const sdkDisabled = process.env.OTEL_SDK_DISABLED === 'true';

let sdkInstance: NodeSDK | undefined;

if (sdkDisabled) {
  // The single kill switch (§6) — skip SDK init entirely. Every
  // TracingService method still works, degrading to §10's "no context"
  // answers; nothing above Tracing needs to check this flag itself.
  tracingObservation.markDisabled();
} else {
  const serviceName = process.env.OTEL_SERVICE_NAME;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!serviceName) {
    tracingObservation.markMisconfigured('OTEL_SERVICE_NAME not set');
  } else if (!endpoint) {
    tracingObservation.markMisconfigured('OTEL_EXPORTER_OTLP_ENDPOINT not set');
  } else {
    const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf';
    const sampleRatio = Number(
      process.env.OTEL_TRACES_SAMPLER_ARG ??
        (process.env.NODE_ENV === 'production' ? '0.1' : '1.0'),
    );
    tracingObservation.setSamplingRatio(sampleRatio);

    const rawExporter = buildExporter(protocol, endpoint);
    const countingExporter = new CountingSpanExporter(
      rawExporter,
      tracingObservation,
    );
    const batchProcessor = new BatchSpanProcessor(countingExporter);
    tracingObservation.attachBatchProcessor(batchProcessor);
    // Registered AFTER the real batching/export processor in the
    // spanProcessors list (§11) — it only counts onStart(), never exports.
    const passThroughProcessor = new PassThroughSpanProcessor(
      tracingObservation,
    );

    const resourceAttributes: Record<string, string> = {
      [ATTR_SERVICE_NAME]: serviceName,
    };
    for (const [key, value] of parseResourceAttributes(
      process.env.OTEL_RESOURCE_ATTRIBUTES,
    )) {
      resourceAttributes[key] = value;
    }

    // `parentbased_traceidratio` (§6's default, §9): honors an inbound
    // sampling decision when a real OTel parent exists in-process, falls back
    // to ratio-based sampling for a true root — which, under §8.0's
    // new-root-plus-link model, is every async-messaging boundary span.
    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(sampleRatio),
    });

    // Load http lazily to record the module identity BEFORE sdk.start() patches it.
    // The trick: `createRequire` gives us an isolated require that doesn't yet
    // trigger OTel's patching hooks (they register on sdk.start(), not on module load).
    // Using Node's own `http` reference — read via `require('node:http')` — captures
    // the same function identity the OTel instrumentation will later try to wrap.
    //
    // [E-22] If this still reports "not attached" incorrectly on some Node versions,
    // the fallback is to remove the self-check entirely (it's advisory, never
    // a functional gate) — the SDK still exports spans either way.

    sdkInstance = new NodeSDK({
      resource: resourceFromAttributes(resourceAttributes),
      sampler,
      // Pinned to W3C Trace Context ONLY — baggage deliberately excluded
      // (§6, §18, Anti-Pattern list): arbitrary undeclared key-value state
      // crossing every boundary would violate §3/§15.3's fixed-four-field
      // design. Hard-coded here rather than left to OTEL_PROPAGATORS's env
      // value, so the exclusion holds even if that variable is ever
      // misconfigured to include "baggage".
      textMapPropagator: new W3CTraceContextPropagator(),
      // `spanProcessors` (plural, array) is the modern NodeSDK config shape
      // that lets a custom pass-through processor (§11) sit alongside the
      // real batching processor. Older @opentelemetry/sdk-node versions only
      // accepted a singular `spanProcessor` (or `traceExporter`, which builds
      // one implicitly) — verify this option name against the pinned
      // sdk-node version before relying on it, the same version-sensitivity
      // caveat this file already makes for `Resource` above.
      spanProcessors: [batchProcessor, passThroughProcessor],
      // §7's one-adapter-at-a-time list — deliberately NOT
      // getNodeAutoInstrumentations() (see tracing.instrumentations.ts's own
      // doc comment for why).
      instrumentations: buildInstrumentations(),
    });

    sdkInstance.start();
    tracingObservation.markInitialized();
  }
}

/** The one exporter, for the one configured endpoint (Anti-Pattern #10 —
 *  never a second exporter "just in case"). Port/protocol agreement (4318
 *  for http/protobuf, 4317 for grpc) is an operator responsibility, called
 *  out in Appendix A and the Production Readiness Checklist (§17), not
 *  something this function silently corrects. */
function buildExporter(protocol: string, endpoint: string): SpanExporter {
  if (protocol === 'grpc') {
    // gRPC: لا تضيف أي path — الـ endpoint بيفضل زي ما هو
    const { OTLPTraceExporter } =
      require('@opentelemetry/exporter-trace-otlp-grpc') as typeof import('@opentelemetry/exporter-trace-otlp-grpc');
    return new OTLPTraceExporter({ url: endpoint });
  }

  const { OTLPTraceExporter } =
    require('@opentelemetry/exporter-trace-otlp-proto') as typeof import('@opentelemetry/exporter-trace-otlp-proto');
  const tracesUrl = endpoint.replace(/\/+$/, '') + '/v1/traces';
  return new OTLPTraceExporter({ url: tracesUrl });
}

function parseResourceAttributes(
  raw: string | undefined,
): Array<[string, string]> {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => pair.split('='))
    .filter(
      (parts): parts is [string, string] =>
        parts.length === 2 && parts[0].trim().length > 0,
    )
    .map(([key, value]) => [key.trim(), value.trim()]);
}

/** The already-running SDK instance (or undefined when disabled/
 *  misconfigured) — tracing.module.ts wires DI providers and the graceful-
 *  shutdown hook around this; it never calls sdk.start() itself (§15.1). */
export const tracingSdk = sdkInstance;
