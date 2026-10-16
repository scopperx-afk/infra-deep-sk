/**
 * DI tokens — Config spec §4.
 *
 * Architecture rule 22: every token is declared here, in this one file, and
 * `Symbol.for()` is forbidden (plain `Symbol()` only — see the "known tradeoff"
 * note in §4).
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
export const CONFIG_SERVICE = Symbol('CONFIG_SERVICE');
export const CONFIG_REGISTRY = Symbol('CONFIG_REGISTRY');
export const CONFIG_OPTIONS = Symbol('CONFIG_OPTIONS');

// ── Internal — NOT exported from index.ts ────────────────────────────────────
// CONFIG_SOURCES: external code assembling a rogue ConfigService straight from
// raw sources would bypass the registry entirely; construction is factory-only,
// via ConfigModule.forRoot() (§4).
export const CONFIG_SOURCES = Symbol('CONFIG_SOURCES');
export const CONFIG_INITIALIZER = Symbol('CONFIG_INITIALIZER');
export const CONFIG_LOADER = Symbol('CONFIG_LOADER');
export const CONFIG_VALIDATOR = Symbol('CONFIG_VALIDATOR');
export const CONFIG_STORE = Symbol('CONFIG_STORE');
export const SECRET_RESOLVER = Symbol('SECRET_RESOLVER');

// Implementation-detail tokens added by this implementation (spec §4 lists the
// six above; these keep the remaining collaborators injectable and testable
// without inventing a second place tokens live).
export const CONFIG_OBSERVATION = Symbol('CONFIG_OBSERVATION');
export const CONFIG_NOTIFIER = Symbol('CONFIG_NOTIFIER');
export const CONFIG_LISTENERS = Symbol('CONFIG_LISTENERS');
