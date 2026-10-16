/**
 * TracingModule — DI wiring + OnApplicationShutdown hook (§15.2). Does NOT
 * call sdk.start() — by the time Nest's module graph is even constructed,
 * the SDK imported from tracing.bootstrap.ts is already running, because
 * main.ts imported that file as its literal first line, before NestFactory
 * (§15.1). Importing tracing.bootstrap.ts again here is safe: Node's module
 * cache means the file's top-level side effects only ever run once.
 */
import {
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { getTraceContext, runWithContext } from './tracing.context';
import {
  deriveContext,
  injectContext,
  runAsBoundary,
  startSpan,
} from './tracing.propagation';
import { tracingObservation, tracingSdk } from './tracing.bootstrap';
import { TRACING_OTEL_SDK, TRACING_SERVICE } from './tracing.tokens';
import type {
  TraceCarrier,
  TraceContext,
  TracingHealth,
  TracingMetricsSnapshot,
  TracingService,
} from './tracing.port';

/**
 * The DI-injectable TracingService — not a second implementation (§4.2): every
 * method here delegates straight to the same plain functions/singleton state
 * the module's plain-function exports use, so the two forms can never drift.
 * Exists for the normal reasons DI exists elsewhere (constructor visibility,
 * mockability in a unit test without touching the real ALS/OTel state).
 */
class TracingServiceImpl implements TracingService {
  getTraceContext(): TraceContext | undefined {
    return getTraceContext();
  }
  runWithContext<T>(ctx: TraceContext, fn: () => T): T {
    return runWithContext(ctx, fn);
  }
  deriveContext(
    carrier?: Partial<TraceCarrier>,
    currentMessageId?: string,
  ): TraceContext {
    return deriveContext(carrier, currentMessageId);
  }
  runAsBoundary<T>(
    spanName: string,
    carrier: Partial<TraceCarrier> | undefined,
    currentMessageId: string | undefined,
    fn: () => T,
  ): T {
    return runAsBoundary(spanName, carrier, currentMessageId, fn);
  }
  injectContext(): TraceCarrier {
    return injectContext();
  }
  startSpan<T>(name: string, fn: () => T): T {
    return startSpan(name, fn);
  }
  getHealth(): TracingHealth {
    return tracingObservation.getHealth();
  }
  getMetricsSnapshot(): TracingMetricsSnapshot {
    return tracingObservation.getMetricsSnapshot();
  }
}

@Module({})
export class TracingModule implements OnApplicationShutdown {
  constructor(
    @Inject(TRACING_OTEL_SDK) private readonly sdk: typeof tracingSdk,
  ) {}

  /**
   * §15.2 step 2 of the three-step shutdown order: flush the OTel SDK
   * (including spans generated during step 1) AFTER every business/domain
   * module's own OnApplicationShutdown hooks have run, and BEFORE Logger
   * flushes last (step 3). NestJS invokes OnApplicationShutdown hooks across
   * the whole module graph in one pass with no built-in per-module priority,
   * so this three-step order is actually achieved by AppModule's own import
   * order — business modules imported before TracingModule, TracingModule
   * imported before the Logger module — not by anything this hook can
   * enforce unilaterally. That ordering requirement belongs to AppModule's
   * own wiring to get right; this hook is simply what step 2 does once its
   * turn comes.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.sdk?.shutdown();
  }

  static forRoot(): DynamicModule {
    const providers: Provider[] = [
      { provide: TRACING_OTEL_SDK, useValue: tracingSdk },
      { provide: TRACING_SERVICE, useFactory: () => new TracingServiceImpl() },
    ];
    return {
      module: TracingModule,
      global: true,
      providers,
      exports: [TRACING_SERVICE],
    };
  }
}
