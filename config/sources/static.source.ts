/**
 * staticSource — Config spec §3.4, §17.3. A first-class, publicly exported testing
 * utility (the one deliberate test-shaped member of the public surface).
 *
 * Keys use the same env-var naming as every other source (`DATABASE__POOL__MAX`).
 * Origin is `test-override`, which has the HIGHEST precedence (§5.7 tier 1).
 * Non-string values are stringified (objects/arrays as JSON) so a test can pass a
 * natural object for a JSON-blob field like `TOKENS__PROFILES`.
 */
import type {
  ConfigSource,
  RawValueWithProvenance,
  SourceHealth,
} from './config-source.port';

export function staticSource(data: Record<string, unknown>): ConfigSource {
  const toRaw = (v: unknown): string =>
    typeof v === 'string'
      ? v
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  return {
    name: 'static',
    critical: true,
    async load(): Promise<Record<string, RawValueWithProvenance>> {
      const out: Record<string, RawValueWithProvenance> = {};
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || v === null) continue;
        out[k] = { value: toRaw(v), origin: 'test-override' };
      }
      return out;
    },
    async health(): Promise<SourceHealth> {
      return { healthy: true, critical: true };
    },
  };
}
