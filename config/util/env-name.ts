/**
 * Env-var name ⇄ dotted path — Config spec §5.1.1 (forward) and §11.5 (reverse).
 */

/** The one deliberate exception to `MODULE__KEY` (§5.1.1, §5.7). */
export const NODE_ENV_NAME = 'NODE_ENV';
export const NODE_ENV_PATH = 'app.env';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * §5.1.1: split on `__`; each segment SCREAMING_SNAKE → camelCase; join with `.`.
 * Returns null for names that cannot be config keys (lower-case names like
 * `npm_config_*`, empty segments from stray underscores) — they are never
 * candidates, so `PATH`/`HOME`/`npm_*` never pollute the merged map.
 */
export function envNameToPath(name: string): string | null {
  if (name === NODE_ENV_NAME) return NODE_ENV_PATH;
  if (!ENV_NAME_RE.test(name)) return null;
  const segments = name.split('__');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.length === 0 || seg.startsWith('_') || seg.endsWith('_'))
      return null;
    const lower = seg.toLowerCase();
    out.push(lower.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));
  }
  return out.join('.');
}

const camelToScreaming = (seg: string): string =>
  seg.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/**
 * §11.5 reverse mapping for an issue path `[namespace, ...issuePath]`.
 *  1. Scalar path: camelCase → SCREAMING_SNAKE, joined by `__`.
 *  2. Inside a JSON-blob field: the blob's own env var + a JSON-pointer-ish
 *     suffix — `tokens.profiles[0].secretRef` → `TOKENS__PROFILES[0].secretRef`.
 */
export function pathToEnvName(
  segments: ReadonlyArray<string | number>,
): string {
  if (segments.length === 2 && segments[0] === 'app' && segments[1] === 'env')
    return NODE_ENV_NAME;
  const firstIndex = segments.findIndex((s) => typeof s === 'number');
  const head = firstIndex === -1 ? segments : segments.slice(0, firstIndex);
  const base = head.map((s) => camelToScreaming(String(s))).join('__');
  if (firstIndex === -1) return base;
  let suffix = '';
  for (const s of segments.slice(firstIndex)) {
    suffix += typeof s === 'number' ? `[${s}]` : `.${s}`;
  }
  return base + suffix;
}
