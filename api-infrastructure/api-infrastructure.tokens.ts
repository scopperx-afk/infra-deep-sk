/**
 * DI tokens — API Infrastructure spec §10, governing principle #22 (explicit tokens, no `Symbol.for`).
 *
 * Deviation E-A10: §10 lists a public `API_INFRASTRUCTURE_OPTIONS` token. Nothing in this module is
 * configured through code options — every knob is an `api.*` Config key — so that token would be
 * defined from habit and consumed by nothing (the same cut Security spec v5 made for
 * `isIpMismatch()`). The one thing a consumer genuinely wants to inject is the resolved, frozen
 * `api.*` namespace (e.g. to echo `pagination.maxLimit` in a capabilities endpoint), so that is
 * the one public token.
 */

// Public
/** The validated, frozen `api.*` Config namespace (`ApiConfig`). */
export const API_CONFIG = Symbol('API_CONFIG');
