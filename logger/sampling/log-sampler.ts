/**
 * Level-based sampling — Logger spec §16. A completely different mechanism from
 * Tracing's own trace-sampling (Tracing spec §9); the two share only the word
 * "sampling." Logger's sampling decides whether a LOG LINE is written at all;
 * it has no effect on whether a span is exported.
 *
 * Critical levels are never randomly sampled away (§16): AUDIT/WARN/ERROR/FATAL
 * are hard-pinned to 100% in code, below — not merely defaulted to 1.0 in
 * `logging.sampling.*` (which only configures trace/debug/info, see
 * config/logging.schema.ts) — so a misconfiguration can never weaken this.
 *
 * ── The force-log / lazy-metadata interaction (a real tension §10 and §16
 * leave unresolved together, resolved here — see SPEC-ERRATA.md E-L3) ─────────
 * §10 requires lazy metadata to be evaluated only once a log line is known to
 * survive sampling; §16 requires a force-log bypass "regardless of level,"
 * which needs to inspect *something* about the call before the sampling
 * decision. Squaring both: the force flag can only ever be read from metadata
 * that is ALREADY a plain object at call time (reading a plain object costs
 * nothing — it's not "evaluating" anything) — a LAZY CALLBACK's return value
 * is, by definition, not yet known before it runs, so it cannot carry a
 * pre-known force flag without defeating the laziness §10 requires. A forced
 * call is therefore expected to pass metadata as a plain object, not a
 * callback — a natural constraint anyway, since "force this" already implies
 * the caller knows the call matters enough to not defer.
 */
import type { LogLevel, LogMetadata, LogMetadataInput } from '../logger.port';

/** Not exported from index.ts directly as a bare symbol — see forceLog() below,
 *  the sanctioned way to set it. */
export const LOG_FORCE: unique symbol = Symbol('logger.forceLog');

/** Tags a plain metadata object so the sampler bypasses its level's ratio entirely (§16).
 *  Has no effect if passed inside a lazy `() => metadata` callback — see this file's header. */
export function forceLog(metadata: LogMetadata = {}): LogMetadata {
  return { ...metadata, [LOG_FORCE]: true };
}

function isForced(metadata: LogMetadataInput | undefined): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<symbol, unknown>)[LOG_FORCE] === true
  );
}

/** AUDIT/WARN/ERROR/FATAL always pass — never configurable, never weakened (§16). */
const ALWAYS_SAMPLED: ReadonlySet<LogLevel> = new Set([
  'audit',
  'warn',
  'error',
  'fatal',
]);

export interface SamplingRatios {
  trace: number;
  debug: number;
  info: number;
}

export class LogSampler {
  constructor(
    private ratios: SamplingRatios,
    private readonly random: () => number = Math.random,
  ) {}

  updateRatios(ratios: SamplingRatios): void {
    this.ratios = ratios;
  }

  /** True = write the line. Never itself evaluates a lazy metadata callback (§10) —
   *  the caller decides sampling using only what's cheaply available (level, and
   *  metadata IF it is already a plain object), then evaluates metadata afterward. */
  shouldSample(
    level: LogLevel,
    metadata: LogMetadataInput | undefined,
  ): boolean {
    if (isForced(metadata)) return true;
    if (ALWAYS_SAMPLED.has(level)) return true;
    const ratio = this.ratios[level as 'trace' | 'debug' | 'info'];
    if (ratio === undefined) return true; // a level this sampler doesn't know about — never silently drop it
    if (ratio >= 1) return true; // avoid a Math.random() call on the hot, common "no sampling" path
    if (ratio <= 0) return false;
    return this.random() < ratio;
  }
}
