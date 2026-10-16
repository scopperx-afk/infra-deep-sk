/**
 * getHealth()/getMetricsSnapshot() state — Logger spec §25, §26. Same pull-based
 * Observation Port pattern as Config (config/observation/config.observation.ts)
 * and Tracing (tracing.health.ts): Logger never imports a Health or Metrics
 * client in either direction.
 *
 * Consolidates spec §40's separate `health/logger.health.ts` and
 * `metrics/logger.metrics.ts` into one state-holder file — the same kind of
 * harmless consolidation Config's own implementation already made for its own
 * module (see Config's README). Health COMPUTATION (§25's critical/non-critical
 * rule) lives in `computeLoggerHealth()` below, applied to live
 * `TransportDispatcher`s that `LoggerService` already holds — this file tracks
 * only the counters (§26), never a transport reference of its own.
 */
import type {
  LogDropReason,
  LogLevel,
  LoggerHealth,
  LoggerMetricsSnapshot,
} from '../logger.port';
import { LOG_LEVEL_ORDER } from '../logger.port';
import type { TransportDispatcher } from '../transports/transport-dispatcher';

const dropKey = (
  reason: LogDropReason,
  level: LogLevel,
  transport: string,
): string => `${reason}|${level}|${transport}`;

export interface DropRecord {
  reason: LogDropReason;
  level: LogLevel;
  transport: string;
}

function emptyLogsByLevel(): Record<LogLevel, number> {
  const out = {} as Record<LogLevel, number>;
  for (const l of LOG_LEVEL_ORDER) out[l] = 0;
  return out;
}

export class LoggerObservation {
  private logsTotal = 0;
  private readonly logsByLevel = emptyLogsByLevel();
  private logsDroppedTotal = 0;
  private readonly dropCounts = new Map<
    string,
    { reason: LogDropReason; level: LogLevel; transport: string; count: number }
  >();
  private transportErrorsTotal = 0;

  recordLog(level: LogLevel): void {
    this.logsTotal += 1;
    this.logsByLevel[level] += 1;
  }

  recordDrop(record: DropRecord): void {
    this.logsDroppedTotal += 1;
    const key = dropKey(record.reason, record.level, record.transport);
    const existing = this.dropCounts.get(key);
    if (existing) existing.count += 1;
    else this.dropCounts.set(key, { ...record, count: 1 });
  }

  recordTransportError(transport: string): void {
    this.transportErrorsTotal += 1;
    void transport; // per-transport error counts are surfaced via LoggerHealth (§25), not split out here (§26 has no such breakdown)
  }

  getMetricsSnapshot(): LoggerMetricsSnapshot {
    return {
      logsTotal: this.logsTotal,
      logsByLevel: { ...this.logsByLevel },
      logsDroppedTotal: this.logsDroppedTotal,
      logsDroppedByReason: [...this.dropCounts.values()].map((v) => ({ ...v })),
      transportErrorsTotal: this.transportErrorsTotal,
    };
  }
}

/**
 * §25's rule, applied to whatever dispatchers `LoggerService` is currently holding:
 * unhealthy iff any CRITICAL transport (Console, always — §25's table) is down;
 * degraded iff any transport at all (necessarily non-critical, since a critical
 * failure already forced `unhealthy`) is down; healthy otherwise.
 */
export function computeLoggerHealth(
  dispatchers: readonly TransportDispatcher[],
): LoggerHealth {
  const transports = dispatchers.map((d) => {
    const h = d.health();
    return {
      name: d.name,
      healthy: h.healthy,
      critical: d.critical,
      ...(h.message ? { message: h.message } : {}),
    };
  });
  const status = transports.some((t) => t.critical && !t.healthy)
    ? 'unhealthy'
    : transports.some((t) => !t.healthy)
      ? 'degraded'
      : 'healthy';
  return { status, transports };
}
