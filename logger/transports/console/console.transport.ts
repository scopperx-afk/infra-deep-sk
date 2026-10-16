/**
 * Console transport — Logger spec §19. The one MANDATORY-Core transport (§42);
 * `critical: true` in `LoggerModule` registration (§25 — "the guaranteed-
 * available fallback — if this fails, nothing else can be trusted to be
 * working either").
 *
 * Built on `pino` (JSON mode) and `pino-pretty` (pretty mode) rather than a
 * hand-rolled `JSON.stringify`/ANSI formatter — real, battle-tested
 * serialization and dev-mode formatting instead of reinventing both. What
 * stays entirely OURS, upstream of this file, is everything the spec defines
 * that neither library has any notion of: the AUDIT level, the
 * redaction/error-serialization/backpressure/sampling pipeline, the exact
 * field set (§11), and the Config/Tracing integration — `entry-builder.ts`
 * hands this transport an already-complete, already-redacted, already-
 * depth-bounded plain object; pino's only job here is turning that object
 * into bytes on the right stream, fast.
 *
 * ── Why two pino instances, not one ─────────────────────────────────────────
 * §19 requires stdout for ordinary levels and stderr for ERROR/FATAL (Unix
 * convention) — pino has no single-instance way to route by level to two
 * DIFFERENT destinations without duplicating lines onto both (its own
 * `multistream` composes minimum-level SUBSCRIPTIONS, not mutually exclusive
 * ranges). Two plain instances, each bound to its own stream, and a single
 * `if` per write, is simpler and exactly matches Unix convention.
 *
 * ── Why AUDIT is a pino `customLevel` at 35, not a home-grown level system ──
 * pino's own 6 levels are trace=10, debug=20, info=30, warn=40, error=50,
 * fatal=60 (a fixed, well-known numbering). `customLevels: { audit: 35 }`
 * (`useOnlyCustomLevels` left false) ADDS audit between info and warn without
 * touching the other six — verified empirically against the pinned pino
 * version (9.6.0) to sit exactly where §5's severity order puts it; pino's own
 * level-ordinal assignment is exactly the kind of "verify against the pinned
 * package version" caveat Tracing's spec already makes for several OTel
 * internals (see SPEC-ERRATA.md E-L5).
 *
 * ── Field order (§11) is "recommended," and pino has its own opinion ────────
 * Passing our own object as pino's SOLE argument (never a second positional
 * message string) means pino serializes exactly our object's own key order,
 * with one exception: pino's `formatters.level` hook injects `level` itself,
 * ahead of every key in our object — so the byte-level order out of this
 * transport is `level, timestamp, message, …` rather than `timestamp, level,
 * message, …`. Every real JSON consumer (Datadog, ELK, CloudWatch) parses
 * this as a map, not order-sensitively, so this is accepted as a pragmatic
 * cost of using pino's real serializer rather than reordering it back by hand.
 */
import pino, { type Logger as PinoLogger } from 'pino';
import { prettyFactory } from 'pino-pretty';
import type { LogEntry, LogLevel } from '../../logger.port';
import type { LogTransport, TransportHealth } from '../transport.interface';

export type ConsoleMode = 'json' | 'pretty';

export interface ConsoleTransportOptions {
  mode: ConsoleMode;
  /** Injectable write streams — defaults to the real process streams; tests supply fakes. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const ERROR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

/** Pinned against pino 9.6.0 — see this file's header. */
const AUDIT_LEVEL_VALUE = 35;
const PRETTY_CUSTOM_LEVELS = `audit:${AUDIT_LEVEL_VALUE}`;
const PRETTY_CUSTOM_COLORS =
  'trace:gray,debug:cyan,info:green,audit:magenta,warn:yellow,error:red,fatal:redBright';

function makePinoWriter(
  destination: NodeJS.WritableStream,
): PinoLogger<'audit'> {
  return pino<'audit'>(
    {
      base: null, // no pid/hostname — not part of §11's field set
      timestamp: false, // `entry.timestamp` is already a real ISO-8601 field on the object we pass
      customLevels: { audit: AUDIT_LEVEL_VALUE },
      formatters: { level: (label: string) => ({ level: label }) },
    },
    destination,
  );
}

/** `JSON.stringify` throws on circular structures and BigInt (pino's JSON mode copes; the
 *  pretty path did not, so a dev-mode log line carrying such a value vanished silently). The
 *  redactor now removes both upstream — this is the defence-in-depth for anything that still
 *  slips through (e.g. a `toJSON()` that returns a cycle). */
function safeStringify(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch (err) {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      logSerializationError: (err as Error).message.split('\n')[0],
    });
  }
}

export class ConsoleTransport implements LogTransport {
  readonly name = 'console';
  private readonly mode: ConsoleMode;
  private readonly stdoutStream: NodeJS.WritableStream;
  private readonly stderrStream: NodeJS.WritableStream;
  private readonly stdoutPino: PinoLogger<'audit'>;
  private readonly stderrPino: PinoLogger<'audit'>;
  private readonly formatPretty?: (jsonLine: string) => string;
  private lastError: string | undefined;

  constructor(options: ConsoleTransportOptions) {
    this.mode = options.mode;
    this.stdoutStream = options.stdout ?? process.stdout;
    this.stderrStream = options.stderr ?? process.stderr;
    this.stdoutPino = makePinoWriter(this.stdoutStream);
    this.stderrPino = makePinoWriter(this.stderrStream);
    if (this.mode === 'pretty') {
      this.formatPretty = prettyFactory({
        colorize: true,
        translateTime: false, // `timestamp` is already a formatted ISO string; print it as-is
        messageKey: 'message',
        levelKey: 'level',
        customLevels: PRETTY_CUSTOM_LEVELS,
        customColors: PRETTY_CUSTOM_COLORS,
        useOnlyCustomProps: false,
      });
    }
  }

  write(entry: LogEntry): void {
    const toStderr = ERROR_LEVELS.has(entry.level);
    try {
      if (this.mode === 'json') {
        const { level, ...rest } = entry; // pino's formatters.level hook supplies `level` itself
        (toStderr ? this.stderrPino : this.stdoutPino)[level](rest);
      } else {
        const line = this.formatPretty!(safeStringify(entry));
        (toStderr ? this.stderrStream : this.stdoutStream).write(line);
      }
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  health(): TransportHealth {
    return this.lastError === undefined
      ? { healthy: true }
      : { healthy: false, message: this.lastError };
  }

  // async-shaped for transports that need it (File/HTTP, §42); nothing to flush here: these
  // pino instances were constructed on a plain caller-owned stream, never pino's own
  // fd-based `pino.destination()`/SonicBoom, so pino itself holds nothing to close.
  async close(): Promise<void> {
    /* nothing to flush or close */
  }
}
