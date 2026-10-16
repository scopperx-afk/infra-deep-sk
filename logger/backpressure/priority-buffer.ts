/**
 * Priority-aware bounded buffer — Logger spec §22. A plain FIFO drop policy risks
 * dropping a FATAL while a buffer full of TRACE lines sits ahead of it; this
 * buffer instead evicts the LOWEST-priority entry currently held, regardless of
 * its position, whenever a new entry would exceed capacity.
 *
 * §22's own table has six tiers and does not mention AUDIT at all (an omission,
 * not a deliberate exclusion — AUDIT sits between INFO and WARN in §5's severity
 * order, and §16 gives it the same "never dropped" sampling protection as
 * WARN/ERROR/FATAL). AUDIT is placed at WARN's priority tier here — same
 * protection class, consistent with §16 — see SPEC-ERRATA.md E-L4.
 *
 * Delivery order for surviving entries stays FIFO (oldest arrival first) — priority
 * only decides what gets EVICTED on overflow, never the order a transport drains
 * the buffer in; reordering a transport's output would be its own kind of surprise.
 */
import type { LogLevel } from '../logger.port';

/** Lower number = dropped first. AUDIT intentionally shares WARN's tier — see header. */
const PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  audit: 3,
  warn: 3,
  error: 4,
  fatal: 5,
};

export interface BufferedEntry<T> {
  level: LogLevel;
  item: T;
}

export interface EnqueueResult<T> {
  accepted: boolean;
  /** The entry that was evicted to make room, if any — the caller uses this to
   *  attribute a `buffer_overflow` drop to the right level for metrics (§26). */
  evicted?: BufferedEntry<T>;
}

export class PriorityDropBuffer<T> {
  private readonly entries: BufferedEntry<T>[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('capacity must be a positive integer');
  }

  get size(): number {
    return this.entries.length;
  }

  /** Never throws, never blocks — the whole point of a backpressure buffer (§22, §35).
   *  Tie-break: when the incoming entry's priority EQUALS the lowest priority already
   *  buffered, the incoming one loses (`incomingPriority <= lowestPriority` below) —
   *  ties favor whatever arrived first, a stable rule, rather than always preferring
   *  the newest entry of a tier (§22 does not specify this either way). */
  enqueue(level: LogLevel, item: T): EnqueueResult<T> {
    if (this.entries.length < this.capacity) {
      this.entries.push({ level, item });
      return { accepted: true };
    }

    const lowestIndex = this.findLowestPriorityIndex();
    const incomingPriority = PRIORITY[level];
    const lowestPriority = PRIORITY[this.entries[lowestIndex].level];

    if (incomingPriority <= lowestPriority) {
      // The incoming entry is no more important than anything already buffered —
      // it is the one that gets dropped, not a space made for it.
      return { accepted: false, evicted: { level, item } };
    }

    const [evicted] = this.entries.splice(lowestIndex, 1);
    this.entries.push({ level, item });
    return { accepted: true, evicted };
  }

  dequeue(): BufferedEntry<T> | undefined {
    return this.entries.shift();
  }

  drain(): BufferedEntry<T>[] {
    return this.entries.splice(0, this.entries.length);
  }

  private findLowestPriorityIndex(): number {
    let lowest = 0;
    for (let i = 1; i < this.entries.length; i++) {
      if (
        PRIORITY[this.entries[i].level] < PRIORITY[this.entries[lowest].level]
      )
        lowest = i;
    }
    return lowest;
  }
}
