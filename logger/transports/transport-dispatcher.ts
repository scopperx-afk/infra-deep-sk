/**
 * Wraps one `LogTransport` with everything §22/§23 require, so an individual
 * transport implementation (Console today; File/HTTP/Sentry later, §42) only
 * ever has to implement the plain `write()`/`health()`/`close()` contract (§18)
 * and never has to reimplement backpressure or failure isolation itself:
 *
 *  - §23 Failure isolation: a transport that throws, rejects, or whose health()
 *    call itself throws NEVER propagates to the caller and NEVER affects any
 *    other transport — caught here, recorded, and swallowed.
 *  - §22 Priority-aware backpressure: at most one write is ever in flight per
 *    transport at a time (bounding concurrent work against a slow transport);
 *    anything arriving while one is in flight queues in a `PriorityDropBuffer`;
 *    once at capacity, the lowest-priority entry is evicted first.
 *  - §26 Metrics: every accepted write, every drop (with its reason), and every
 *    transport error is counted here, in one place, so `LoggerObservation` never
 *    has to know per-transport dispatch details.
 */
import type { LogLevel, LogEntry } from '../logger.port';
import type { LoggerObservation } from '../observation/logger.observation';
import { PriorityDropBuffer } from '../backpressure/priority-buffer';
import { emergencyLog } from '../bootstrap/emergency-logger';
import type {
  LogTransport,
  TransportHealth,
  TransportRegistration,
} from './transport.interface';

const DEFAULT_BUFFER_CAPACITY = 1000;
/** A write that has not settled after this long is abandoned: the transport is treated as
 *  stalled, the slot is freed and the queue keeps moving. Without it ONE never-settling write
 *  (stalled disk, black-holed network sink) pins `inFlight` forever — every later line is
 *  queued, then dropped, while `health()` still says "healthy". */
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
/** At most one emergency stderr line per this interval when a CRITICAL transport loses lines. */
const EMERGENCY_REPORT_INTERVAL_MS = 1_000;

export class TransportDispatcher {
  readonly name: string;
  readonly critical: boolean;
  private readonly transport: LogTransport;
  private readonly buffer: PriorityDropBuffer<LogEntry>;
  private inFlight = false;
  private closed = false;
  private stalled = false;
  /** Identifies the write currently in flight, so the late settlement of one we already
   *  gave up on (timeout) is recognised and ignored. */
  private writeSeq = 0;
  private lastEmergencyAt = 0;

  constructor(
    registration: TransportRegistration,
    private readonly observation: LoggerObservation,
    bufferCapacity: number = DEFAULT_BUFFER_CAPACITY,
    private readonly writeTimeoutMs: number = DEFAULT_WRITE_TIMEOUT_MS,
  ) {
    this.transport = registration.transport;
    this.name = registration.transport.name;
    this.critical = registration.critical;
    this.buffer = new PriorityDropBuffer<LogEntry>(bufferCapacity);
  }

  /** Never throws, never awaited by the caller — dispatch is fire-and-forget from
   *  LoggerService's perspective (§35: logging must be low-overhead). */
  dispatch(level: LogLevel, entry: LogEntry): void {
    if (this.closed) {
      // shutting down — see close(). Counted, not silent.
      this.observation.recordDrop({ reason: 'transport_closed', level, transport: this.name });
      return;
    }
    if (this.inFlight) {
      const result = this.buffer.enqueue(level, entry);
      // `result.evicted` is whichever entry lost out — the incoming one if the buffer held
      // nothing lower-priority to make room with, or an older buffered one otherwise (§22).
      if (result.evicted) {
        this.observation.recordDrop({
          reason: 'buffer_overflow',
          level: result.evicted.level,
          transport: this.name,
        });
      }
      return;
    }
    this.runWrite(level, entry);
  }

  health(): TransportHealth {
    let h: TransportHealth;
    try {
      h = this.transport.health();
    } catch (err) {
      return {
        healthy: false,
        message: `health() threw: ${(err as Error).message}`,
      };
    }
    // The transport's own view can say "healthy" while nothing is being delivered.
    if (h.healthy && this.stalled)
      return {
        healthy: false,
        message: `a write did not settle within ${this.writeTimeoutMs}ms — transport appears stalled`,
      };
    return h;
  }

  /** §34 — best-effort final flush within the given budget, then close. */
  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight && Date.now() < deadline) await sleep(10);

    const pending = this.buffer.drain();
    let i = 0;
    for (; i < pending.length; i++) {
      if (Date.now() >= deadline) break;
      try {
        await withTimeout(
          this.transport.write(pending[i].item),
          Math.max(0, deadline - Date.now()),
        );
      } catch (err) {
        this.observation.recordTransportError(this.name);
        void err; // isolated — a failed final flush must not block shutdown (§23, §34)
      }
    }
    // Whatever the budget did not allow us to flush is lost — say so in the metrics.
    for (; i < pending.length; i++)
      this.observation.recordDrop({
        reason: 'transport_closed',
        level: pending[i].level,
        transport: this.name,
      });

    try {
      await withTimeout(
        this.transport.close(),
        Math.max(0, deadline - Date.now()),
      );
    } catch (err) {
      this.observation.recordTransportError(this.name);
      void err;
    }
  }

  private runWrite(level: LogLevel, entry: LogEntry): void {
    this.inFlight = true;
    const seq = ++this.writeSeq;
    let result: Promise<void> | void;
    try {
      result = this.transport.write(entry);
    } catch (err) {
      this.onWriteSettled(seq, entry, true, err);
      return;
    }
    if (!isPromiseLike(result)) {
      this.onWriteSettled(seq, entry, false, undefined);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    if (this.writeTimeoutMs > 0) {
      timer = setTimeout(() => {
        this.stalled = true;
        this.onWriteSettled(
          seq,
          entry,
          true,
          new Error(`write timed out after ${this.writeTimeoutMs}ms`),
        );
      }, this.writeTimeoutMs);
      timer.unref?.();
    }
    result.then(
      () => {
        if (timer) clearTimeout(timer);
        this.onWriteSettled(seq, entry, false, undefined);
      },
      (err: unknown) => {
        if (timer) clearTimeout(timer);
        this.onWriteSettled(seq, entry, true, err);
      },
    );
  }

  private onWriteSettled(
    seq: number,
    entry: LogEntry,
    failed: boolean,
    err: unknown,
  ): void {
    // A write we already abandoned (timeout) settling late — or settling twice — is ignored.
    if (seq !== this.writeSeq || !this.inFlight) return;
    this.inFlight = false;

    if (failed) {
      this.observation.recordTransportError(this.name); // §23 — isolated, never rethrown
      this.reportLoss(entry, err);
    } else {
      this.stalled = false;
      // Built-in transports (Console/File/Sentry) catch their own errors and expose them via
      // health() instead of throwing, so a LOST line looked like a successful write and the
      // transport-error metric stayed at 0. Reading health() right after the write closes
      // that blind spot.
      const h = this.health();
      if (!h.healthy) {
        this.observation.recordTransportError(this.name);
        this.reportLoss(entry, h.message);
      }
    }
    if (this.closed) return;
    const next = this.buffer.dequeue();
    if (next) this.runWrite(next.level, next.item);
  }

  /** A CRITICAL transport (Console — "if this fails, nothing else can be trusted") losing a
   *  line used to be completely silent. The emergency logger (§27) has no dependencies and
   *  writes straight to stderr; rate-limited so a dead stdout cannot become a stderr flood. */
  private reportLoss(entry: LogEntry, cause: unknown): void {
    if (!this.critical) return;
    const now = Date.now();
    if (now - this.lastEmergencyAt < EMERGENCY_REPORT_INTERVAL_MS) return;
    this.lastEmergencyAt = now;
    const reason = cause instanceof Error ? cause : new Error(String(cause ?? 'write failed'));
    emergencyLog(
      `critical log transport '${this.name}' failed — a log line was lost: [${entry.level}] ${String(entry.message).slice(0, 200)}`,
      reason,
    );
  }
}

function isPromiseLike(v: unknown): v is Promise<void> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PromiseLike<void>).then === 'function'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T> {
  if (!isPromiseLike(value)) return Promise.resolve(value as T);
  if (ms <= 0) {
    // Budget already spent: do NOT adopt the pending promise (the first implementation did —
    // `Promise.resolve(value)` follows it, so close() hung forever on a stuck transport).
    (value as Promise<T>).catch(() => undefined); // no unhandled rejection from the abandoned write
    return Promise.reject(new Error('timed out'));
  }
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([value as Promise<T>, timeout]).finally(() =>
    clearTimeout(timer),
  );
}
