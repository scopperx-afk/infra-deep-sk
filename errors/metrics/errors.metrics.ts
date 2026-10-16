/**
 * Metrics — Errors spec §19. No `getHealth()` here on purpose: this module has
 * no adapter, no network connection, nothing a health check could meaningfully
 * observe (§19, Anti-Pattern #10) — every input arrives already in-process.
 *
 * `errorsByCategory.unknown` is the number worth watching: it increments only
 * for §7's fourth, un-classified case — a rising count is a direct signal of a
 * real uncaught bug, not an expected client error.
 */
import { Injectable } from '@nestjs/common';
import type { ErrorCategory } from '../domain/app-error';

export interface ErrorsMetricsSnapshot {
  errorsTotal: number;
  errorsByCategory: Record<ErrorCategory | 'unknown', number>;
  errorsByCode: Record<string, number>;
  errorsByStatus: Record<number, number>;
}

export interface ErrorsMetricsCollector {
  record(
    category: ErrorCategory | 'unknown',
    status: number,
    code: string,
  ): void;
  getMetricsSnapshot(): ErrorsMetricsSnapshot;
}

/** `errorsByCode` keys come from `AppError.code`, which a subclass controls — a code built from
 *  data (`\`NOT_FOUND_${entity}\``) would grow the map without bound. Past this many distinct
 *  codes, new ones are folded into one overflow bucket. */
const MAX_DISTINCT_CODES = 100;
export const OVERFLOW_CODE = '_OTHER';

@Injectable()
export class ErrorsMetricsCollectorService implements ErrorsMetricsCollector {
  private total = 0;
  private readonly byCategory: Record<ErrorCategory | 'unknown', number> = {
    domain: 0,
    validation: 0,
    infrastructure: 0,
    unknown: 0,
  };
  private readonly byCode = new Map<string, number>();
  private readonly byStatus = new Map<number, number>();

  record(
    category: ErrorCategory | 'unknown',
    status: number,
    code: string,
  ): void {
    this.total += 1;
    this.byCategory[category] += 1;
    const key = this.byCode.has(code) || this.byCode.size < MAX_DISTINCT_CODES ? code : OVERFLOW_CODE;
    this.byCode.set(key, (this.byCode.get(key) ?? 0) + 1);
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
  }

  getMetricsSnapshot(): ErrorsMetricsSnapshot {
    return {
      errorsTotal: this.total,
      errorsByCategory: { ...this.byCategory },
      errorsByCode: Object.fromEntries(this.byCode),
      errorsByStatus: Object.fromEntries(this.byStatus),
    };
  }
}
