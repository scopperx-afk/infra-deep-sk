/**
 * `logging.*` — registered by Logger itself via `ConfigModule.forFeature()`
 * (Config spec §12: every module registers its own namespace; Config's own
 * catalog, §13.11, is the design document, not the registration code).
 *
 * Config's §13.11 catalog lists exactly two `logging.*` keys — `level` (a
 * 4-value enum) and `redact.paths`. This schema keeps both, WIDENS `level` to
 * the full 7-value LogLevel (Logger spec §5 — restricting an operator to 4 of
 * 7 levels would be a functional regression, not a decision stated anywhere),
 * and adds the further settings §11–§16/§20/§21/§24 need. See
 * SPEC-ERRATA.md E-L1, E-L9, E-L10.
 *
 * ── `maxSizeMb`, not `maxSizeMB` (fixed after review) ───────────────────────
 * Config's own env→path conversion lowercases the whole segment before
 * re-title-casing each `_`-joined piece (the exact same mechanism E-8 already
 * documents for `REDIS__PUB_SUB_DB` → `redis.pubSubDb`): `MAX_SIZE_MB` becomes
 * `maxSizeMb` — a lowercase trailing `b`, never `maxSizeMB`. A schema key of
 * `maxSizeMB` would silently never receive the env var at all (Zod fills in
 * the field's own `.default()` instead, with no error) — the single-letter
 * casing mismatch was a real, live bug, not a style nit. Field renamed to
 * match what Config actually produces.
 *
 * `file` and `sentry` below are now REAL, consumed schemas — not placeholders
 * (see file.transport.ts / sentry.transport.ts), and every other field name is
 * still chosen to match the already-deployed `.env` exactly
 * (`LOGGING__FILE__APP_PATH`, `LOGGING__SENTRY__ENVIRONMENT`, …).
 */
import { z } from 'zod';
import { booleanSchema, csvArray, numberSchema } from '../../config';
import { LOG_LEVEL_ORDER } from '../logger.port';
import {
  DEFAULT_FILE_MAX_FILES,
  DEFAULT_FILE_MAX_SIZE_MB,
  DEFAULT_METADATA_SIZE_LIMIT_BYTES,
  DEFAULT_SENTRY_TRACES_SAMPLE_RATE,
} from '../logger.constants';

const ratio = (fallback: number) =>
  numberSchema
    .pipe(
      z
        .number()
        .min(0, 'must be between 0 and 1')
        .max(1, 'must be between 0 and 1'),
    )
    .default(fallback);

export const loggingConfigSchema = z.object({
  /** Hot-reload whitelisted (Config spec §10.1) — the exact leaf `logging.level`. */
  level: z
    .enum(LOG_LEVEL_ORDER as [string, ...string[]])
    .default('info') as z.ZodType<(typeof LOG_LEVEL_ORDER)[number]>,
  /** `"json"` in production by default, `"pretty"` in development/test — left unset here and
   *  resolved against `app.env` at Logger's own bootstrap (§19), the same "no value here means
   *  derive from app.env" pattern Config itself uses nowhere but which this module needs once. */
  format: z.enum(['json', 'pretty']).optional(),
  redact: z
    .object({
      /** Extra dotted paths (application-level, not Config-level) Logger should scrub — data
       *  Config carries FOR Logger, not a mechanism Config implements itself (§13.11, §14). */
      paths: csvArray(z.string().min(1)).default(''),
    })
    .default({}),
  metadata: z
    .object({
      sizeLimitBytes: numberSchema
        .pipe(z.number().int().positive())
        .default(DEFAULT_METADATA_SIZE_LIMIT_BYTES),
      /** truncate-with-marker (recommended default) or reject-and-warn (§15). */
      sizeLimitPolicy: z.enum(['truncate', 'reject']).default('truncate'),
    })
    .default({}),
  sampling: z
    .object({
      /** Only TRACE/DEBUG/INFO are configurable — AUDIT/WARN/ERROR/FATAL are hard-pinned to
       *  100% in code (log-sampler.ts), never weakened by configuration (§16: "critical levels
       *  are never randomly sampled away" is a requirement, not a recommended default). */
      trace: ratio(1),
      debug: ratio(1),
      info: ratio(1),
    })
    .default({}),
  /**
   * §20 — File transport (E-L9 — file.transport.ts). Always writes JSON lines
   * regardless of `logging.format`; see file.transport.ts's own header for
   * why there's no "pretty" file mode. `appPath` gets every level; `errorPath`
   * gets ERROR/FATAL duplicated alongside it (the same stdout/stderr split
   * ConsoleTransport makes, §19, persisted to disk instead).
   *
   * Rotation triggers on whichever of size or date comes first (when
   * `datePattern` isn't `'none'`); `maxFiles` bounds how many ROTATED BACKUPS
   * are kept (not counting the active file) — pruned oldest-first by mtime,
   * so date- and size-triggered backups are pruned by the same rule.
   * `maxFiles` has a hard floor of 2: `1` would mean "retain zero backups,"
   * which is really "don't rotate at all" spelled confusingly — set
   * `enabled: false` instead if that's genuinely what's wanted.
   */
  file: z
    .object({
      enabled: booleanSchema.default(false),
      appPath: z.string().min(1).default('app.log'),
      errorPath: z.string().min(1).default('error.log'),
      maxSizeMb: numberSchema
        .pipe(z.number().int().positive())
        .default(DEFAULT_FILE_MAX_SIZE_MB),
      maxFiles: numberSchema
        .pipe(z.number().int().min(2, 'must be at least 2 — see file header'))
        .default(DEFAULT_FILE_MAX_FILES),
      /** Gzips each rotated backup (not the active file) — typically 80-90% smaller for
       *  JSON-lines text. On by default: a production log volume without this is a disk
       *  bill waiting to happen. */
      compress: booleanSchema.default(true),
      /** Rotates on a calendar boundary in addition to size — `'none'` (size-only, the
       *  original behavior) is the default because a low-traffic service can otherwise
       *  go months on one file; `'daily'`/`'hourly'` give a predictable upper bound on a
       *  single file's age regardless of volume. Checked lazily, on the next write after
       *  the boundary — there is no background timer. */
      datePattern: z.enum(['none', 'daily', 'hourly']).default('none'),
    })
    .default({})
    .superRefine((v, ctx) => {
      if (v.enabled && v.appPath === v.errorPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['errorPath'],
          message:
            'logging.file.errorPath must differ from logging.file.appPath — writing both to one file defeats the split',
        });
      }
    }),
  http: z
    .object({
      enabled: booleanSchema.default(false),
      endpoint: z.string().url().optional(),
    })
    .default({})
    .superRefine((v, ctx) => {
      if (v.enabled && !v.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoint'],
          message: 'required when logging.http.enabled is true',
        });
      }
    }),
  /**
   * §24 — Sentry transport (E-L10 — sentry.transport.ts). `environment`
   * defaults to `app.env` at bootstrap (logger.module.ts) when left unset,
   * the same "derive from app.env" pattern `format` above uses.
   */
  sentry: z
    .object({
      enabled: booleanSchema.default(false),
      dsn: z.string().url().optional(),
      environment: z.string().min(1).optional(),
      tracesSampleRate: ratio(DEFAULT_SENTRY_TRACES_SAMPLE_RATE),
    })
    .default({})
    .superRefine((v, ctx) => {
      if (v.enabled && !v.dsn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dsn'],
          message: 'required when logging.sentry.enabled is true',
        });
      }
    }),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

/** `logging.sentry.dsn` is the one secret in this namespace (an ingest DSN is a bearer
 *  credential) — declared the same way Database declares `secretPaths: ['url']`. */
export const LOGGING_SECRET_PATHS = ['sentry.dsn'];
