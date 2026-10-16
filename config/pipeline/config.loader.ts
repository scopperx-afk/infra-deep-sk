/**
 * Pipeline steps 1–3 — Config spec §6.
 *
 *  1. Load  — every source reads its own native format, in parallel, tagged with
 *             provenance. Values are NOT transformed here.
 *  2. Parse — convert each source's native KEY names into dotted paths (§5.1.1 for
 *             env/dotenv sources). Touches key names only, plus whitespace
 *             trimming — skipped for secret paths (§5.1).
 *  3. Merge — one raw value + provenance per dotted path, by precedence (§5.7).
 */
import type { ConfigNotice } from '../config.port';
import type { ConfigNotifier } from '../notices/config.notice';
import type { ConfigObservation } from '../observation/config.observation';
import type {
  ConfigSource,
  ConfigValueOrigin,
  RawValueWithProvenance,
} from '../sources/config-source.port';
import type { MergedEntry } from '../store/config.store';
import { nowIso, nowMs } from '../util/clock';
import { NODE_ENV_NAME, NODE_ENV_PATH, envNameToPath } from '../util/env-name';

export interface SourceLoadOutcome {
  source: ConfigSource;
  records?: Record<string, RawValueWithProvenance>;
  error?: string;
  durationSec: number;
  loadedAt: string;
}

/**
 * §5.7 precedence, highest wins:
 *   1 test override · 2 process.env · (remote: sits below process.env — deferred, §5.6)
 *   · 3 .env.{NODE_ENV}/.env (committed, merged inside the dotenv source) · 5 schema defaults.
 * `.local` files rank above committed ones (see dotenv.source.ts).
 */
const ORIGIN_RANK: Record<ConfigValueOrigin, number> = {
  'test-override': 5,
  'process.env': 4,
  remote: 3,
  'local-file': 2,
  'committed-file': 1,
};

/** Source key → dotted path, or null if it cannot be a config key. */
export function sourceKeyToPath(
  source: ConfigSource,
  key: string,
): string | null {
  return source.keyFormat === 'dotted' ? key : envNameToPath(key);
}

export class ConfigLoader {
  /** Step 1. Never throws: a failing source becomes an outcome with `error`. */
  async loadSources(
    sources: readonly ConfigSource[],
    observation: ConfigObservation,
    notifier: ConfigNotifier,
  ): Promise<{ outcomes: SourceLoadOutcome[]; errors: string[] }> {
    const outcomes = await Promise.all(
      sources.map(async (source): Promise<SourceLoadOutcome> => {
        const started = nowMs();
        const loadedAt = nowIso();
        try {
          const records = await source.load();
          return {
            source,
            records,
            durationSec: (nowMs() - started) / 1000,
            loadedAt,
          };
        } catch (err) {
          return {
            source,
            error: (err as Error).message,
            durationSec: (nowMs() - started) / 1000,
            loadedAt,
          };
        }
      }),
    );

    const errors: string[] = [];
    for (const o of outcomes) {
      const status = o.error === undefined ? 'success' : 'failure';
      observation.incCounter('config_loads_total', {
        source: o.source.name,
        status,
      });
      observation.observe(
        'config_load_duration_seconds',
        { source: o.source.name },
        o.durationSec,
      );
      if (o.error !== undefined) {
        observation.incCounter('config_load_failures_total', {
          source: o.source.name,
          reason: 'load_error',
        });
        if (o.source.critical) {
          // Joins the same aggregate list as schema failures (§5, §7.9).
          errors.push(
            `config source "${o.source.name}" (critical) failed to load: ${o.error}`,
          );
        } else {
          const notice: ConfigNotice = {
            level: 'warning',
            code: 'optional-source-unavailable',
            message: `optional config source "${o.source.name}" failed to load — continuing degraded: ${o.error}`,
          };
          notifier.notify(notice);
        }
      }
    }
    return { outcomes, errors };
  }

  /** Steps 2 + 3. */
  parseAndMerge(
    outcomes: readonly SourceLoadOutcome[],
    ctx: {
      isSecretRawPath: (dotted: string) => boolean;
      notifier: ConfigNotifier;
    },
  ): Map<string, MergedEntry> {
    const merged = new Map<string, MergedEntry>();

    for (const outcome of outcomes) {
      if (!outcome.records) continue;
      for (const [key, raw] of Object.entries(outcome.records)) {
        const path = sourceKeyToPath(outcome.source, key);
        if (path === null) continue;

        // NODE_ENV is the single source of truth for the environment; it is NOT
        // derived from APP__ENV or anything else (§5.7).
        if (
          outcome.source.keyFormat !== 'dotted' &&
          path === NODE_ENV_PATH &&
          key !== NODE_ENV_NAME
        ) {
          ctx.notifier.notify({
            level: 'warning',
            code: 'ignored-app-env',
            message: `${key} is ignored: the environment comes only from NODE_ENV (§5.7).`,
          });
          continue;
        }

        const entry: MergedEntry = {
          path,
          // Trimming is skipped for secret paths (§5.1): trimming happens here, after
          // every namespace registered (§17.2), so the decision is precise.
          value: ctx.isSecretRawPath(path) ? raw.value : raw.value.trim(),
          origin: raw.origin,
          envName: key,
          sourceName: outcome.source.name,
          viaFile: raw.viaFile === true,
        };
        const existing = merged.get(path);
        // `>=`: on equal rank the later source in the array wins.
        if (
          !existing ||
          ORIGIN_RANK[entry.origin] >= ORIGIN_RANK[existing.origin]
        )
          merged.set(path, entry);
      }
    }
    return merged;
  }
}
