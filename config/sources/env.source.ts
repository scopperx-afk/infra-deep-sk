/**
 * EnvironmentConfigSource — Config spec §5.1. `critical: true`; origin `process.env`.
 *
 * One of the very few files in the code base allowed to touch `process.env`
 * (Anti-Pattern #1 exempts "the Config module's own source adapters"). Values are
 * NOT converted or coerced here — key→path conversion is pipeline step 2 (§6).
 */
import { nowMs } from '../util/clock';
import type {
  ConfigSource,
  RawValueWithProvenance,
  SourceHealth,
} from './config-source.port';
import { expandFileReferences } from './file-reference';

export class EnvironmentConfigSource implements ConfigSource {
  readonly name = 'environment';
  readonly critical = true;

  private lastLatencyMs: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly cwd: string = process.cwd(),
  ) {}

  async load(): Promise<Record<string, RawValueWithProvenance>> {
    const started = nowMs();
    try {
      const entries: Record<string, RawValueWithProvenance> = {};
      for (const [key, value] of Object.entries(this.env)) {
        if (typeof value === 'string')
          entries[key] = { value, origin: 'process.env' };
      }
      const expanded = await expandFileReferences(entries, this.cwd);
      this.lastError = undefined;
      return expanded;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.lastLatencyMs = nowMs() - started;
    }
  }

  async health(): Promise<SourceHealth> {
    return {
      healthy: this.lastError === undefined,
      critical: this.critical,
      latencyMs: this.lastLatencyMs,
      message: this.lastError,
    };
  }
}
