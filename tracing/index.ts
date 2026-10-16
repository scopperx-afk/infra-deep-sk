/**
 * tracing/index.ts — the ONLY public surface of the Tracing module (§5, §13,
 * §16), mirroring config/index.ts's own role for Config.
 *
 * Everything else (tracing.bootstrap.ts's SDK internals, tracing.context.ts's
 * ALS singleton, tracing.propagation.ts's branching logic, tracing.health.ts's
 * processor/exporter decorators, …) is unreachable from outside `tracing/`,
 * enforced by the same ESLint boundary rule Config uses: `src/infrastructure/
 * tracing/**` may only be imported via this file. `http.correlationHeader` is
 * the one deliberate exception project-wide — it lives in Config's own
 * catalog and is read by HTTP the normal way (§6, §12), not through this file.
 *
 * tracing.bootstrap.ts is NOT re-exported here on purpose: it is imported
 * exactly once, directly, as the literal first line of main.ts (§15.1) —
 * never through this barrel file, and never by any other consumer.
 */

// Plain functions — no DI, no constructor injection (§4.2). Call sites that
// would otherwise need to thread a DI token through several layers (Logger's
// hot-path formatter, an error class's constructor, a low-level utility with
// no constructor at all) reach the same singleton context store through a
// plain function call instead. These are not a second implementation — they
// are the literal functions TracingServiceImpl (tracing.module.ts) delegates
// to, both backed by the same module-level AsyncLocalStorage singleton.
export { getTraceContext, runWithContext } from './tracing.context';
export {
  deriveContext,
  injectContext,
  runAsBoundary,
  startSpan,
} from './tracing.propagation';
// NOTE: §4.2's own code sketch enumerates getTraceContext/runWithContext/
// deriveContext/runAsBoundary/injectContext but not startSpan, even though
// §4.1 defines startSpan as an ordinary TracingService method and §4.2's own
// opening paragraph — reaching the same DI-free store from a constructor-less
// call site — applies to it identically. Exporting it as a plain function too
// is a deliberate, spec-consistent extension of that enumeration, not a
// deviation from it: withholding the one port method whose entire purpose is
// ad hoc manual span creation from the DI-free surface would undercut §4.2's
// own stated rationale for the other five.

export { TracingModule } from './tracing.module';
export { TRACING_SERVICE } from './tracing.tokens';

export type {
  TraceCarrier,
  TraceContext,
  TracingHealth,
  TracingMetricsSnapshot,
  TracingService,
} from './tracing.port';

// §13 — a real testing utility, not an internal leak (matches config/index.ts's
// own export of staticSource for exactly the same reason).
export { withTraceContext } from './testing/with-trace-context';
