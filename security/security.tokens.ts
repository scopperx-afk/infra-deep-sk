/**
 * DI tokens — Security spec §21/§22.
 *
 * Architecture rule 22: every token is declared in this one file, plain
 * `Symbol()` only — `Symbol.for()` is forbidden (enforced by boundary.spec.ts).
 *
 * The spec's own code samples declare `PROFILE_VALIDATORS`, `SECURITY_ALERT_EMITTER`
 * … next to the port that uses them; this file is where they actually live so the
 * "one tokens file" rule holds. The public NAMES are unchanged (SPEC-ERRATA E-S11).
 */

// ── Public (re-exported from index.ts) ───────────────────────────────────────
export const PROFILE_VALIDATORS = Symbol('PROFILE_VALIDATORS'); // §5.3 — ProfileValidatorRegistry
export const SECURITY_ALERT_EMITTER = Symbol('SECURITY_ALERT_EMITTER'); // §17.2
export const ANOMALY_DETECTOR = Symbol('ANOMALY_DETECTOR'); // §17.3
export const REPLAY_PROTECTION_STORE = Symbol('REPLAY_PROTECTION_STORE'); // §18.2
export const CACHE_INVALIDATION_BUS = Symbol('CACHE_INVALIDATION_BUS'); // §20

// ── Internal — NOT exported from index.ts ────────────────────────────────────
export const SECURITY_CLOCK = Symbol('SECURITY_CLOCK'); // injectable time source (architecture rule: no bare Date.now())
export const SECURITY_RUNTIME_BOOTSTRAP = Symbol('SECURITY_RUNTIME_BOOTSTRAP'); // pushes Config-derived defaults into the plain-function utilities
export const SECURITY_CONFIG_VALIDATION = Symbol('SECURITY_CONFIG_VALIDATION'); // registers cross-namespace config rules
export const SECURITY_IP_POLICY = Symbol('SECURITY_IP_POLICY'); // the global allow/block policy compiled from `security.ipPolicy.*`
