/**
 * Hot-reload whitelist — Config spec §10.1.
 *
 * NO hot-reload for everything. This project's actual whitelist is exactly two
 * entries. Feature flags are deliberately NOT here: the Feature Flags module owns
 * dynamic flag delivery (Redis pub/sub), and routing flags through Config would
 * create two competing update paths for the same data. This resolves ADR-002.
 *
 * Grammar (pinned in §10.1 — nothing else exists):
 *  - an exact dotted path (`logging.level`) matches that single leaf, and nothing else;
 *  - a dotted prefix ending in `.*` (`rateLimit.*`) matches the entire subtree BELOW
 *    that prefix, at any depth (`rateLimit.default.ttlSeconds`);
 *  - no leading `*`, no mid-path `*`, no `**`;
 *  - array-element paths are NEVER matchable (rotating a token profile means
 *    re-issuing tokens, not live-swapping a secret).
 *
 * ⚠️ Adding an entry requires first confirming it has no cross-namespace validation
 * dependency — hot-reload does NOT re-run step 4c (§10.3).
 */
import { ConfigRegistrationError } from '../config.port';

export const HOT_RELOAD_WHITELIST: readonly string[] = [
  'logging.level',
  'rateLimit.*',
];

const ENTRY_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*(\.\*)?$/;

/** A path that points into an array (`profiles[0]`, `profiles.0.x`) is never matchable. */
const pointsIntoArray = (path: string): boolean =>
  path.includes('[') || path.split('.').some((s) => /^\d+$/.test(s));

export function matchesWhitelist(
  path: string,
  entries: readonly string[] = HOT_RELOAD_WHITELIST,
): boolean {
  if (pointsIntoArray(path)) return false;
  return entries.some((entry) =>
    entry.endsWith('.*')
      ? path.startsWith(`${entry.slice(0, -2)}.`)
      : path === entry,
  );
}

/** May a listener subscribe to a whole namespace? Only if some entry lives inside it. */
export function namespaceHasWhitelistedPath(
  namespace: string,
  entries: readonly string[] = HOT_RELOAD_WHITELIST,
): boolean {
  return entries.some((entry) => entry.split('.')[0] === namespace);
}

/**
 * `ConfigModuleOptions.hotReload.paths` may NARROW the project whitelist, never widen
 * it. Throws ConfigRegistrationError synchronously (at forRoot()).
 */
export function assertWithinWhitelist(paths: readonly string[]): void {
  for (const entry of paths) {
    if (!ENTRY_RE.test(entry)) {
      throw new ConfigRegistrationError(
        `Invalid hot-reload path "${entry}": use an exact dotted path or a trailing ".*" prefix — no other wildcard forms exist (§10.1).`,
      );
    }
    const within = entry.endsWith('.*')
      ? HOT_RELOAD_WHITELIST.some((w) => {
          if (!w.endsWith('.*')) return false;
          const wp = w.slice(0, -2);
          const p = entry.slice(0, -2);
          return p === wp || p.startsWith(`${wp}.`);
        })
      : matchesWhitelist(entry, HOT_RELOAD_WHITELIST);
    if (!within) {
      throw new ConfigRegistrationError(
        `Hot-reload path "${entry}" is not covered by the project whitelist (${HOT_RELOAD_WHITELIST.join(', ')}). ` +
          `Extending the whitelist is an ADR-level decision (§10.1), not a module option.`,
      );
    }
  }
}
