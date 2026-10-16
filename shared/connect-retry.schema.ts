/**
 * `<namespace>.connectRetry.*` — ONE Zod shape for every connection-owning module.
 *
 * Database (`database.connectRetry`, `mongo.connectRetry`), Redis, Storage, Queue and
 * Events' transport each own their own namespace (separate budgets, separate counters —
 * Database spec §8), but the SHAPE and the DEFAULTS must not drift between them. Each
 * module nests this schema under its own key:
 *
 *     connectRetry: connectRetrySchema,            // → REDIS__CONNECT_RETRY__MAX_ATTEMPTS …
 *
 * The three keys the specs and the existing `.env` already use (`maxAttempts`,
 * `initialDelayMs`, `maxDelayMs`; defaults 5 / 500 / 8000 ≈ 15 s total) are unchanged. The
 * three extras (`jitterRatio`, `attemptTimeoutMs`, `overallDeadlineMs`) are OPTIONAL with
 * safe defaults, so no `.env` has to change — and per the Database spec's own rule 6, each
 * is a key added to Config's catalog, not invented locally.
 *
 * The parsed value has exactly the shape of `ConnectRetryOptions`, so a module passes
 * `config.getNamespace('redis').connectRetry` straight to `connectWithRetry({ retry })`.
 */
import { z } from 'zod';
import { numberSchema } from '../config';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_JITTER_RATIO } from './connect-with-retry';

const intIn = (min: number, max: number) => numberSchema.pipe(z.number().int().min(min).max(max));

/** `FOO=` (empty in a `.env`) means "unset" for an optional number. */
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), intIn(min, max).optional());

export const DEFAULT_CONNECT_RETRY = Object.freeze({
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 8000,
});

export const connectRetrySchema = z
  .object({
    maxAttempts: intIn(1, 100).default(DEFAULT_CONNECT_RETRY.maxAttempts),
    initialDelayMs: intIn(1, 600_000).default(DEFAULT_CONNECT_RETRY.initialDelayMs),
    maxDelayMs: intIn(1, 600_000).default(DEFAULT_CONNECT_RETRY.maxDelayMs),
    jitterRatio: numberSchema.pipe(z.number().min(0).max(1)).default(DEFAULT_JITTER_RATIO),
    attemptTimeoutMs: intIn(100, 600_000).default(DEFAULT_ATTEMPT_TIMEOUT_MS),
    overallDeadlineMs: optionalInt(100, 3_600_000),
  })
  .default({})
  .superRefine((v, ctx) => {
    if (v.maxDelayMs < v.initialDelayMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxDelayMs'], message: 'maxDelayMs must be >= initialDelayMs' });
    }
    if (v.overallDeadlineMs !== undefined && v.overallDeadlineMs < v.attemptTimeoutMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overallDeadlineMs'], message: 'overallDeadlineMs must be >= attemptTimeoutMs' });
    }
  });

export type ConnectRetryConfig = z.infer<typeof connectRetrySchema>;
