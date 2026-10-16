/**
 * ConfigSource contract — Config spec §5.
 *
 * Every source records not just the value but WHERE it came from. That
 * provenance travels through the whole pipeline (§6) and is what the production
 * secret guard (§9.2) actually checks.
 */
import type { Environment } from '../config.port';

export type Unsubscribe = () => void;

export type ConfigValueOrigin =
  'process.env' | 'committed-file' | 'local-file' | 'remote' | 'test-override';

export interface RawValueWithProvenance {
  value: string;
  /** Where this raw value came from — needed for the production guard (§9.2). */
  origin: ConfigValueOrigin;
  /**
   * Internal marker: the value was read from a `KEY_FILE` reference (§5.2).
   * Only such values may legitimately contain raw newlines (PEM keys).
   */
  viaFile?: boolean;
}

export interface SourceHealth {
  healthy: boolean;
  critical: boolean;
  latencyMs?: number;
  message?: string;
}

export interface ConfigSource {
  readonly name: string;
  /**
   * Whether this source failing to load is fatal (aborts boot, §11.2) or
   * degrades gracefully. Classified explicitly per source — never implicit.
   */
  readonly critical: boolean;
  /**
   * How `load()` keys are shaped. `'env'` (default): SCREAMING__SNAKE env-var
   * names, converted with the §5.1.1 algorithm. `'dotted'`: keys are already
   * dotted paths (reserved for the deferred JSON/YAML source, §5.3).
   */
  readonly keyFormat?: 'env' | 'dotted';
  /**
   * Environments in which `watch()` may be started. Omitted = any. The dotenv
   * source sets `['development','test']`: a committed file is never a legitimate
   * live-update mechanism in staging/production (§5.6).
   */
  readonly watchEnvironments?: readonly Environment[];
  /**
   * Raw values in THIS SOURCE'S OWN NATIVE key format. Never converts names to
   * dotted paths and never transforms values (no CSV splitting, no JSON.parse) —
   * see §6 step 2 and §7.6/§7.8 for where those actually happen.
   */
  load(): Promise<Record<string, RawValueWithProvenance>>;
  /**
   * Same key format and provenance shape as load(). A secret-marked path
   * reported through watch() is rejected at validation time (§10.2).
   */
  watch?(
    callback: (updates: Record<string, RawValueWithProvenance>) => void,
  ): Unsubscribe;
  /**
   * Reflects the health of the last load() AND, if watch() is active, the current
   * watch connection.
   */
  health(): Promise<SourceHealth>;
}
